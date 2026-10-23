import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { actorFrom } from '../../../common/bo/actor.bo.js';
import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { Roles } from '../../../common/decorators/roles.decorator.js';
import { toPage } from '../../../common/dto/pagination.dto.js';
import type { AuthenticatedUser } from '../../../common/interfaces/authenticated-user.interface.js';
import { CreateProductRequestDto, ProductQueryDto, SetProductStatusRequestDto, UpdateProductRequestDto } from '../dto/product.request.dto.js';
import { ProductPageResponseDto, ProductResponseDto } from '../dto/product.response.dto.js';
import { ProductMapper } from '../mappers/product.mapper.js';
import { ProductsService } from '../services/products.service.js';

@ApiTags('Admin · Products')
@ApiBearerAuth()
@Roles('admin')
@Controller('admin/products')
export class AdminProductsController {
  constructor(private readonly products: ProductsService) {}

  @Get()
  async list(@Query() query: ProductQueryDto): Promise<ProductPageResponseDto> {
    return toPage(await this.products.list(query), ProductMapper.toDto);
  }

  @Get(':id')
  async get(@Param('id') id: string): Promise<ProductResponseDto> {
    return ProductMapper.toDto(await this.products.get(id));
  }

  @Post()
  async create(@CurrentUser() user: AuthenticatedUser, @Body() body: CreateProductRequestDto): Promise<ProductResponseDto> {
    const product = await this.products.create(actorFrom(user), {
      ...body,
      dimensions: body.dimensions || null,
      features: body.features ?? [],
      imageUrl: body.imageUrl ?? null,
      isActive: body.isActive ?? true,
      rewardEligible: body.rewardEligible ?? true,
    });
    return ProductMapper.toDto(product);
  }

  @Delete(':id')
  @HttpCode(204)
  async delete(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string): Promise<void> {
    await this.products.delete(actorFrom(user), id);
  }

  @Patch(':id')
  async update(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: UpdateProductRequestDto): Promise<ProductResponseDto> {
    const { dimensions, imageUrl, ...rest } = body;
    const patch = {
      ...rest,
      ...(dimensions !== undefined ? { dimensions: dimensions || null } : {}),
      ...(imageUrl !== undefined ? { imageUrl: imageUrl || null } : {}),
    };
    return ProductMapper.toDto(await this.products.update(actorFrom(user), id, patch));
  }

  @Patch(':id/status')
  async setStatus(@CurrentUser() user: AuthenticatedUser, @Param('id') id: string, @Body() body: SetProductStatusRequestDto): Promise<ProductResponseDto> {
    return ProductMapper.toDto(await this.products.update(actorFrom(user), id, { isActive: body.isActive }));
  }
}
