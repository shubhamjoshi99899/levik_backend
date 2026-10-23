import { Injectable } from '@nestjs/common';
import type { ActorBo } from '../../../common/bo/actor.bo.js';
import { AppException, ErrorCode } from '../../../common/errors/app.exception.js';
import type { Page } from '../../../common/dto/pagination.dto.js';
import { AuditService } from '../../audit/services/audit.service.js';
import type { ProductBo, ProductInputBo, ProductQueryBo } from '../bo/product.bo.js';
import { ProductMapper } from '../mappers/product.mapper.js';
import { ProductsRepository } from '../repositories/products.repository.js';
import { UploadsService } from '../../uploads/services/uploads.service.js';
import { UPLOAD_KEY_PATTERN } from '../../uploads/storage/storage-driver.interface.js';

@Injectable()
export class ProductsService {
  constructor(
    private readonly products: ProductsRepository,
    private readonly audit: AuditService,
    private readonly uploads: UploadsService,
  ) {}

  /** imageUrl is a catalogue path/URL or the key of a product-image upload (shown through a signed link). */
  private async assertImage(imageUrl: string | null | undefined): Promise<void> {
    if (imageUrl && UPLOAD_KEY_PATTERN.test(imageUrl)) await this.uploads.assertExists(imageUrl, 'product-image');
  }

  async list(query: ProductQueryBo): Promise<Page<ProductBo>> {
    const page = await this.products.findPage(query);
    return { ...page, items: page.items.map(ProductMapper.toBo) };
  }

  async get(id: string): Promise<ProductBo> {
    const product = await this.products.findById(id);
    if (!product) throw AppException.notFound('Product', id);
    return ProductMapper.toBo(product);
  }

  async getActive(id: string): Promise<ProductBo> {
    const product = await this.get(id);
    if (!product.isActive) throw AppException.notFound('Product', id);
    return product;
  }

  async findByBarcode(barcode: string): Promise<ProductBo> {
    const product = await this.products.findByBarcode(barcode);
    if (!product) throw AppException.notFound('Product with barcode', barcode);
    return ProductMapper.toBo(product);
  }

  async create(actor: ActorBo, input: ProductInputBo): Promise<ProductBo> {
    await this.assertImage(input.imageUrl);
    if (await this.products.skuTaken(input.sku)) {
      throw AppException.rule(ErrorCode.DUPLICATE, `SKU ${input.sku} already exists.`);
    }
    const id = await this.products.insert(input);
    await this.audit.record(actor, { action: 'Product created', entityType: 'Product', entityId: id, summary: `${input.name} (${input.modelCode}) added` });
    return this.get(id);
  }

  async update(actor: ActorBo, id: string, patch: Partial<ProductInputBo>): Promise<ProductBo> {
    const current = await this.get(id);
    await this.assertImage(patch.imageUrl);
    if (patch.sku && (await this.products.skuTaken(patch.sku, id))) {
      throw AppException.rule(ErrorCode.DUPLICATE, `SKU ${patch.sku} already exists.`);
    }
    const changed = (Object.keys(patch) as Array<keyof ProductInputBo>).filter(
      (k) => patch[k] !== undefined && JSON.stringify(patch[k]) !== JSON.stringify(current[k]),
    );
    if (changed.length === 0) return current;
    await this.products.update(id, Object.fromEntries(changed.map((k) => [k, patch[k]])));
    const action = changed.length === 1 && changed[0] === 'isActive' ? (patch.isActive ? 'Product activated' : 'Product deactivated') : 'Product edited';
    await this.audit.record(actor, { action, entityType: 'Product', entityId: id, summary: `${current.name} · changed: ${changed.join(', ')}` });
    return this.get(id);
  }

  async delete(actor: ActorBo, id: string): Promise<void> {
    const product = await this.get(id);
    await this.products.delete(id);
    await this.audit.record(actor, { action: 'Product deleted', entityType: 'Product', entityId: id, summary: `${product.name} (${product.modelCode}) deleted` });
  }
}
