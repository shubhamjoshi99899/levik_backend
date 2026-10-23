import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager, In } from 'typeorm';
import { likePattern, type Page } from '../../../common/dto/pagination.dto.js';
import { BaseRepository } from '../../../database/base.repository.js';
import type { ProductInputBo, ProductQueryBo } from '../bo/product.bo.js';
import { ProductDao } from '../dao/product.dao.js';

@Injectable()
export class ProductsRepository extends BaseRepository<ProductDao> {
  constructor(dataSource: DataSource) {
    super(dataSource, ProductDao);
  }

  async findPage(query: ProductQueryBo): Promise<Page<ProductDao>> {
    const qb = this.repo().createQueryBuilder('p').orderBy('p.id', 'ASC');
    if (query.category) qb.andWhere('p.category = :category', { category: query.category });
    if (query.isActive !== undefined) qb.andWhere('p.isActive = :isActive', { isActive: query.isActive });
    if (query.search) {
      // Same expression as the trigram index products_search_idx.
      qb.andWhere(`(p.name || ' ' || p.model_code || ' ' || p.sku) ILIKE :q`, { q: likePattern(query.search) });
    }
    const [items, total] = await qb.skip((query.page - 1) * query.pageSize).take(query.pageSize).getManyAndCount();
    return { items, total, page: query.page, pageSize: query.pageSize };
  }

  findById(id: string, manager?: EntityManager): Promise<ProductDao | null> {
    return this.repo(manager).findOneBy({ id });
  }

  async findByIds(ids: string[], manager?: EntityManager): Promise<Map<string, ProductDao>> {
    if (ids.length === 0) return new Map();
    const rows = await this.repo(manager).findBy({ id: In([...new Set(ids)]) });
    return new Map(rows.map((p) => [p.id, p]));
  }

  findByBarcode(barcode: string): Promise<ProductDao | null> {
    return this.repo().findOneBy({ barcode, isActive: true });
  }

  async skuTaken(sku: string, excludeId?: string): Promise<boolean> {
    const qb = this.repo().createQueryBuilder('p').where('lower(p.sku) = lower(:sku)', { sku });
    if (excludeId) qb.andWhere('p.id <> :excludeId', { excludeId });
    return (await qb.getCount()) > 0;
  }

  async insert(input: ProductInputBo): Promise<string> {
    const result = await this.repo().createQueryBuilder().insert().values(input).returning(['id']).execute();
    return (result.raw as Array<{ id: string }>)[0].id;
  }

  async update(id: string, patch: Partial<ProductInputBo>): Promise<void> {
    await this.repo().update({ id }, patch);
  }

  async delete(id: string): Promise<void> {
    await this.repo().delete({ id });
  }
}
