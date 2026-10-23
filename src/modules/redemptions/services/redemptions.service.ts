import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import type { ActorBo } from '../../../common/bo/actor.bo.js';
import { failedBlocking, type CheckBo } from '../../../common/bo/check.bo.js';
import type { RedemptionStatus, RewardType, UserRole } from '../../../common/domain/enums.js';
import { AppException, ErrorCode } from '../../../common/errors/app.exception.js';
import type { Page } from '../../../common/dto/pagination.dto.js';
import { TransactionService } from '../../../database/transaction.service.js';
import { AuditService } from '../../audit/services/audit.service.js';
import { ParticipantsRepository } from '../../participants/repositories/participants.repository.js';
import { PointsService } from '../../points/services/points.service.js';
import { RewardsService } from '../../rewards/services/rewards.service.js';
import type { FulfilmentDetailsBo, RedemptionBo, RedemptionQueryBo, RedemptionReviewBo } from '../bo/redemption.bo.js';
import type { RedemptionDao } from '../dao/redemption.dao.js';
import { RedemptionMapper } from '../mappers/redemption.mapper.js';
import { RedemptionsRepository } from '../repositories/redemptions.repository.js';

/** Allowed fulfilment moves. Approval is the only step that deducts points. */
export function nextStatuses(status: RedemptionStatus, rewardType: RewardType): RedemptionStatus[] {
  switch (status) {
    case 'Requested':
      return ['Approved', 'Cancelled'];
    case 'Approved':
      return ['Processing', 'Cancelled'];
    case 'Processing':
      return rewardType === 'Physical' ? ['Dispatched', 'Failed', 'Cancelled'] : ['Delivered', 'Failed', 'Cancelled'];
    case 'Dispatched':
      return ['Delivered'];
    default:
      return [];
  }
}

@Injectable()
export class RedemptionsService {
  constructor(
    private readonly redemptions: RedemptionsRepository,
    private readonly rewards: RewardsService,
    private readonly points: PointsService,
    private readonly participants: ParticipantsRepository,
    private readonly tx: TransactionService,
    private readonly audit: AuditService,
  ) {}

  // ------------------------------------------------------------------ reads
  async list(query: RedemptionQueryBo): Promise<Page<RedemptionBo>> {
    const page = await this.redemptions.findPage(query);
    const names = await this.participants.findByIds(page.items.map((d) => d.userId));
    return { ...page, items: page.items.map((d) => RedemptionMapper.toBo(d, names.get(d.userId)?.name)) };
  }

  statusCounts(userId?: string): Promise<Record<string, number>> {
    return this.redemptions.statusCounts(userId);
  }

  async get(id: string, ownerId?: string, manager?: EntityManager): Promise<RedemptionBo> {
    const row = await this.redemptions.findWithReward(id, manager);
    if (!row || (ownerId && row.userId !== ownerId)) throw AppException.notFound('Redemption', id);
    const participant = await this.participants.findById(row.userId, manager);
    return RedemptionMapper.toBo(row, participant?.name);
  }

  async review(id: string): Promise<RedemptionReviewBo> {
    const redemption = await this.get(id);
    const [userPoints, checks, ledger, timeline] = await Promise.all([
      this.points.balance(redemption.userId),
      this.checks(redemption),
      this.points.ledger({ page: 1, pageSize: 10, relatedType: 'redemption', relatedId: id }),
      this.audit.timeline('redemption', id),
    ]);
    return { redemption, userPoints, checks, nextStatuses: nextStatuses(redemption.status, redemption.reward.type), ledgerEntries: ledger.items, timeline };
  }

  // ----------------------------------------------------------------- admin
  /** Deducts points exactly once and takes one unit of stock. */
  async approve(actor: ActorBo, id: string): Promise<RedemptionBo> {
    await this.tx.run(async (manager) => {
      const locked = await this.lockOrFail(id, manager);
      if (locked.status !== 'Requested') throw AppException.invalidState('Only requested redemptions can be approved.');
      if (locked.debitTxnId) throw AppException.alreadyProcessed('Points have already been deducted for this redemption.');

      // Serialise every balance change for this user, then lock the reward row for the stock decrement.
      await this.points.lockParticipant(manager, locked.userId);
      const reward = await this.rewards.lockForUpdate(locked.rewardId, manager);
      const failed = failedBlocking(await this.checks(await this.get(id, undefined, manager), manager));
      if (failed.length) throw AppException.rule(ErrorCode.CHECKS_FAILED, `Cannot approve: ${failed.map((c) => c.label).join(', ')}.`, failed);

      const stock = await this.rewards.changeStock(reward.id, -1, manager);
      const debitTxnId = await this.points.post(manager, actor, {
        userId: locked.userId,
        role: locked.userRole,
        source: 'Redemption',
        amount: -locked.pointsCost,
        note: `Redeemed: ${reward.name}`,
        related: { type: 'redemption', id },
      });
      await this.redemptions.update(id, { status: 'Approved', debitTxnId }, manager);
      await this.audit.recordEvent(actor, { entityType: 'redemption', entityId: id, action: 'Approved', note: `${locked.pointsCost} points deducted · stock now ${stock}` }, manager);
      await this.audit.record(
        actor,
        { action: 'Redemption approved', entityType: 'Redemption', entityId: id, summary: `${locked.pointsCost} pts deducted from ${locked.userId}; ${reward.name} stock now ${stock}` },
        manager,
      );
    });
    return this.get(id);
  }

  /** Fulfilment moves. Never deducts again; Cancelled/Failed after approval refunds once and restores stock. */
  async transition(actor: ActorBo, id: string, next: Exclude<RedemptionStatus, 'Requested' | 'Approved'>, details: FulfilmentDetailsBo): Promise<RedemptionBo> {
    await this.tx.run(async (manager) => {
      const locked = await this.lockOrFail(id, manager);
      const reward = await this.rewards.lockForUpdate(locked.rewardId, manager);
      if (!nextStatuses(locked.status, reward.type).includes(next)) {
        throw AppException.invalidState(`Cannot move a ${locked.status} redemption to ${next}.`);
      }
      const patch: Partial<RedemptionDao> = { status: next };
      let note: string | undefined;
      const stamp = new Date().toISOString().replace(/\D/g, '').slice(4, 12);

      if (next === 'Processing') {
        patch.fulfilmentRef = `FUL-${id.slice(4)}-${stamp}`;
        note = `Fulfilment reference ${patch.fulfilmentRef}`;
      } else if (next === 'Dispatched') {
        patch.courierName = details.courierName || 'Levik Demo Logistics';
        patch.trackingNumber = details.trackingNumber || `LDL${id.slice(4)}${stamp}`;
        note = `${patch.courierName} · tracking ${patch.trackingNumber}`;
      } else if (next === 'Delivered' && reward.type === 'Digital') {
        patch.voucherCode = details.voucherCode || locked.voucherCode || `DEMO-${id.slice(4)}-${stamp.slice(-4)}`;
        note = 'Voucher code issued';
      } else if (next === 'Cancelled' || next === 'Failed') {
        const reason = details.reason?.trim();
        if (!reason || reason.length < 5) throw AppException.rule(ErrorCode.VALIDATION_FAILED, 'A reason of at least 5 characters is required.');
        patch.cancelReason = reason;
        note = reason;
        if (locked.debitTxnId && !locked.reversalTxnId) {
          await this.points.lockParticipant(manager, locked.userId);
          patch.reversalTxnId = await this.points.post(manager, actor, {
            userId: locked.userId,
            role: locked.userRole,
            source: 'Redemption Reversal',
            amount: locked.pointsCost,
            note: `Refund for ${next.toLowerCase()} redemption ${id}`,
            related: { type: 'redemption', id },
          });
          await this.rewards.changeStock(reward.id, 1, manager);
          note = `${reason} · ${locked.pointsCost} points refunded, stock restored`;
        }
      }

      await this.redemptions.update(id, patch, manager);
      await this.audit.recordEvent(actor, { entityType: 'redemption', entityId: id, action: next, note }, manager);
      await this.audit.record(actor, { action: `Redemption ${next.toLowerCase()}`, entityType: 'Redemption', entityId: id, summary: note ?? `${id} moved to ${next}` }, manager);
    });
    return this.get(id);
  }

  // ------------------------------------------------------------- mobile app
  /** Creates a request. Points move only when an admin approves it. */
  async request(userId: string, role: UserRole, rewardId: string, deliveryAddress: string): Promise<RedemptionBo> {
    const id = await this.tx.run(async (manager) => {
      const participant = await this.participants.findById(userId, manager);
      if (!participant) throw AppException.notFound('Account');
      if (participant.accountStatus !== 'Active') {
        throw AppException.rule(ErrorCode.ACCOUNT_INACTIVE, `Your account is ${participant.accountStatus.toLowerCase()}. Contact Levik support.`);
      }
      await this.points.lockParticipant(manager, userId);
      const reward = await this.rewards.lockForUpdate(rewardId, manager);
      if (!reward.isActive) throw AppException.rule(ErrorCode.INVALID_STATE, 'This reward is not available.');
      if (!reward.eligibleRoles.includes(role)) throw AppException.rule(ErrorCode.INVALID_STATE, 'This reward is not available for your account type.');
      if (reward.stock <= 0) throw AppException.rule(ErrorCode.OUT_OF_STOCK, 'This reward is out of stock.');

      const available = await this.points.available(userId, manager);
      if (available < reward.pointsRequired) {
        throw AppException.rule(ErrorCode.INSUFFICIENT_POINTS, 'Not enough points for this reward.', { available, required: reward.pointsRequired });
      }
      const redemptionId = await this.redemptions.insert({ userId, userRole: role, rewardId, pointsCost: reward.pointsRequired, deliveryAddress }, manager);
      await this.audit.recordEvent({ id: userId, name: participant.name }, { entityType: 'redemption', entityId: redemptionId, action: 'Redemption requested from app' }, manager);
      return redemptionId;
    });
    return this.get(id);
  }

  async cancelOwn(userId: string, id: string): Promise<RedemptionBo> {
    await this.tx.run(async (manager) => {
      const locked = await this.lockOrFail(id, manager);
      if (locked.userId !== userId) throw AppException.notFound('Redemption', id);
      if (locked.status !== 'Requested') throw AppException.invalidState('Only requests that are not yet approved can be cancelled.');
      await this.redemptions.update(id, { status: 'Cancelled', cancelReason: 'Cancelled by user' }, manager);
      await this.audit.recordEvent({ id: userId, name: userId }, { entityType: 'redemption', entityId: id, action: 'Cancelled by user' }, manager);
    });
    return this.get(id, userId);
  }

  // ----------------------------------------------------------------- rules
  private async checks(redemption: RedemptionBo, manager?: EntityManager): Promise<CheckBo[]> {
    const [available, participant] = await Promise.all([
      this.points.available(redemption.userId, manager),
      this.participants.findById(redemption.userId, manager),
    ]);
    const reward = await this.rewards.get(redemption.reward.id, manager);
    return [
      {
        label: 'Sufficient points balance',
        passed: available >= redemption.pointsCost,
        blocking: true,
        detail: `Available ${available.toLocaleString('en-IN')} pts · required ${redemption.pointsCost.toLocaleString('en-IN')} pts`,
      },
      { label: 'Reward in stock', passed: reward.stock > 0, blocking: true, detail: `${reward.stock} units available` },
      { label: 'Reward active', passed: reward.isActive, blocking: true, detail: reward.isActive ? 'Reward is active in the catalogue' : 'Reward is deactivated' },
      {
        label: 'Account in good standing',
        passed: participant?.accountStatus === 'Active',
        blocking: true,
        detail: participant ? `${participant.name} · ${participant.accountStatus}` : 'User not found',
      },
    ];
  }

  private async lockOrFail(id: string, manager: EntityManager): Promise<RedemptionDao> {
    const row = await this.redemptions.findByIdForUpdate(id, manager);
    if (!row) throw AppException.notFound('Redemption', id);
    return row;
  }
}
