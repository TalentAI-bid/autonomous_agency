'use client';

import * as React from 'react';
import { useProducts, useCreateProduct, useUpdateProduct, useDeleteProduct, useSuggestProduct } from '@/hooks/use-products';
import { useAuthStore } from '@/stores/auth.store';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog';
import { useToast } from '@/hooks/use-toast';
import { Package, Plus, Pencil, Trash2, Loader2, Sparkles } from 'lucide-react';
import type { Product } from '@/types';

const PRICING_MODELS = [
  { value: '', label: 'Select pricing model' },
  { value: 'subscription', label: 'Subscription' },
  { value: 'per_seat', label: 'Per Seat' },
  { value: 'one_time', label: 'One-Time' },
  { value: 'usage_based', label: 'Usage-Based' },
  { value: 'freemium', label: 'Freemium' },
  { value: 'custom', label: 'Custom' },
];

const PRODUCT_LIMITS: Record<string, number> = {
  free: 1,
  starter: 5,
  pro: 20,
  enterprise: Infinity,
};

function splitTags(val: string): string[] {
  return val.split(',').map(s => s.trim()).filter(Boolean);
}

function joinTags(arr?: string[] | null): string {
  return (arr ?? []).join(', ');
}

type ProductForm = {
  name: string;
  description: string;
  category: string;
  targetAudience: string;
  painPointsSolved: string;
  keyFeatures: string;
  differentiators: string;
  pricingModel: string;
  pricingDetails: string;
};

const emptyForm: ProductForm = {
  name: '',
  description: '',
  category: '',
  targetAudience: '',
  painPointsSolved: '',
  keyFeatures: '',
  differentiators: '',
  pricingModel: '',
  pricingDetails: '',
};

function toFormState(product: Product): ProductForm {
  return {
    name: product.name,
    description: product.description ?? '',
    category: product.category ?? '',
    targetAudience: product.targetAudience ?? '',
    painPointsSolved: joinTags(product.painPointsSolved),
    keyFeatures: joinTags(product.keyFeatures),
    differentiators: joinTags(product.differentiators),
    pricingModel: product.pricingModel ?? '',
    pricingDetails: product.pricingDetails ?? '',
  };
}

function toPayload(form: ProductForm) {
  return {
    name: form.name.trim(),
    description: form.description.trim() || undefined,
    category: form.category.trim() || undefined,
    targetAudience: form.targetAudience.trim() || undefined,
    painPointsSolved: splitTags(form.painPointsSolved),
    keyFeatures: splitTags(form.keyFeatures),
    differentiators: splitTags(form.differentiators),
    pricingModel: form.pricingModel || undefined,
    pricingDetails: form.pricingDetails.trim() || undefined,
  };
}

export default function ProductsPage() {
  const { data: products, isLoading } = useProducts();
  const createProduct = useCreateProduct();
  const updateProduct = useUpdateProduct();
  const deleteProduct = useDeleteProduct();
  const suggestProduct = useSuggestProduct();
  const tenant = useAuthStore(s => s.tenant);
  const { toast } = useToast();

  const [dialogOpen, setDialogOpen] = React.useState(false);
  const [editingProduct, setEditingProduct] = React.useState<Product | null>(null);
  const [form, setForm] = React.useState<ProductForm>(emptyForm);

  const plan = tenant?.plan ?? 'free';
  const limit = PRODUCT_LIMITS[plan] ?? 1;
  const count = (products ?? []).length;

  function openCreate() {
    setEditingProduct(null);
    setForm(emptyForm);
    setDialogOpen(true);
  }

  function openEdit(product: Product) {
    setEditingProduct(product);
    setForm(toFormState(product));
    setDialogOpen(true);
  }

  async function handleDelete(id: string) {
    try {
      await deleteProduct.mutateAsync(id);
      toast({ title: 'Product deleted' });
    } catch {
      toast({ title: 'Failed to delete product', variant: 'destructive' });
    }
  }

  async function handleToggleActive(product: Product) {
    try {
      await updateProduct.mutateAsync({ id: product.id, isActive: !product.isActive });
    } catch {
      toast({ title: 'Failed to update product', variant: 'destructive' });
    }
  }

  async function handleAiSuggest() {
    if (!form.name.trim()) {
      toast({ title: 'Enter a product name first', variant: 'destructive' });
      return;
    }
    try {
      const result = await suggestProduct.mutateAsync(form.name.trim());
      const s = result.suggestion;
      setForm(f => ({
        ...f,
        description: s.description ?? f.description,
        category: s.category ?? f.category,
        targetAudience: s.targetAudience ?? f.targetAudience,
        painPointsSolved: s.painPointsSolved?.length ? joinTags(s.painPointsSolved) : f.painPointsSolved,
        keyFeatures: s.keyFeatures?.length ? joinTags(s.keyFeatures) : f.keyFeatures,
        differentiators: s.differentiators?.length ? joinTags(s.differentiators) : f.differentiators,
        pricingModel: s.pricingModel ?? f.pricingModel,
        pricingDetails: s.pricingDetails ?? f.pricingDetails,
      }));
      toast({ title: 'AI suggestions applied' });
    } catch {
      toast({ title: 'Failed to generate suggestions', variant: 'destructive' });
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!form.name.trim()) {
      toast({ title: 'Product name is required', variant: 'destructive' });
      return;
    }

    try {
      if (editingProduct) {
        await updateProduct.mutateAsync({ id: editingProduct.id, ...toPayload(form) });
        toast({ title: 'Product updated' });
      } else {
        await createProduct.mutateAsync(toPayload(form));
        toast({ title: 'Product created' });
      }
      setDialogOpen(false);
      setForm(emptyForm);
      setEditingProduct(null);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to save product';
      toast({ title: msg, variant: 'destructive' });
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-6 w-32" />
        {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-32" />)}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Package className="w-6 h-6" /> Products & Services
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Manage what you sell. Agents use this to personalize outreach.
          </p>
        </div>
        <Button size="sm" onClick={openCreate} disabled={count >= limit}>
          <Plus className="w-4 h-4 mr-2" /> Add Product
        </Button>
      </div>

      {/* Plan limit indicator */}
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <span>
          Using <strong className="text-foreground">{count}</strong> of{' '}
          <strong className="text-foreground">{limit === Infinity ? 'unlimited' : limit}</strong>{' '}
          products
        </span>
        <Badge variant="outline" className="text-xs capitalize">{plan} plan</Badge>
        {count >= limit && limit !== Infinity && (
          <span className="text-amber-500 text-xs">
            Limit reached — upgrade to add more
          </span>
        )}
      </div>

      {/* Product list */}
      {count === 0 ? (
        <Card>
          <CardContent className="py-16 text-center">
            <Package className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-sm font-medium">No products yet</p>
            <p className="text-xs text-muted-foreground mt-1 mb-4">
              Add your first product to help agents personalize outreach
            </p>
            <Button size="sm" onClick={openCreate}>
              <Plus className="w-4 h-4 mr-2" /> Add Product
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {(products ?? []).map(product => (
            <Card key={product.id} className={!product.isActive ? 'opacity-60' : ''}>
              <CardContent className="py-4">
                <div className="flex items-start justify-between gap-4">
                  {/* Left: product info */}
                  <div className="space-y-2 min-w-0 flex-1">
                    {/* Name + badges */}
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{product.name}</span>
                      {product.category && (
                        <Badge variant="secondary" className="text-xs">{product.category}</Badge>
                      )}
                      {product.pricingModel && (
                        <Badge variant="outline" className="text-xs capitalize">
                          {product.pricingModel.replace('_', ' ')}
                        </Badge>
                      )}
                      <Badge
                        variant={product.isActive ? 'secondary' : 'destructive'}
                        className="text-xs"
                      >
                        {product.isActive ? 'Active' : 'Inactive'}
                      </Badge>
                    </div>

                    {/* Description */}
                    {product.description && (
                      <p className="text-sm text-muted-foreground line-clamp-2">
                        {product.description}
                      </p>
                    )}

                    {/* Target audience */}
                    {product.targetAudience && (
                      <p className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">Target:</span>{' '}
                        {product.targetAudience}
                      </p>
                    )}

                    {/* Pricing */}
                    {product.pricingDetails && (
                      <p className="text-xs text-muted-foreground">
                        <span className="font-medium text-foreground">Pricing:</span>{' '}
                        {product.pricingDetails}
                      </p>
                    )}

                    {/* Tags row */}
                    <div className="flex flex-wrap gap-1">
                      {(product.keyFeatures ?? []).slice(0, 4).map((f, i) => (
                        <Badge key={`f-${i}`} variant="outline" className="text-xs">
                          {f}
                        </Badge>
                      ))}
                      {(product.painPointsSolved ?? []).slice(0, 3).map((p, i) => (
                        <Badge key={`p-${i}`} variant="warning" className="text-xs">
                          {p}
                        </Badge>
                      ))}
                      {((product.keyFeatures?.length ?? 0) + (product.painPointsSolved?.length ?? 0)) > 7 && (
                        <Badge variant="outline" className="text-xs text-muted-foreground">
                          +{(product.keyFeatures?.length ?? 0) + (product.painPointsSolved?.length ?? 0) - 7} more
                        </Badge>
                      )}
                    </div>
                  </div>

                  {/* Right: actions */}
                  <div className="flex items-center gap-1 shrink-0">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleToggleActive(product)}
                      disabled={updateProduct.isPending}
                    >
                      {product.isActive ? 'Disable' : 'Enable'}
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => openEdit(product)}
                    >
                      <Pencil className="w-3.5 h-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => handleDelete(product.id)}
                      disabled={deleteProduct.isPending}
                    >
                      <Trash2 className="w-3.5 h-3.5 text-destructive" />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {editingProduct ? 'Edit Product' : 'Add Product'}
            </DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-1.5">
              <Label>Product Name *</Label>
              <div className="flex gap-2">
                <Input
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g., Cloud Migration Service"
                  required
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleAiSuggest}
                  disabled={!form.name.trim() || suggestProduct.isPending}
                  className="shrink-0 gap-1.5"
                >
                  {suggestProduct.isPending ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="w-3.5 h-3.5" />
                  )}
                  AI Suggest
                </Button>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Description</Label>
              <Textarea
                value={form.description}
                onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                placeholder="Brief description of the product or service"
                rows={3}
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Category</Label>
                <Input
                  value={form.category}
                  onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                  placeholder="e.g., SaaS, Consulting"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Pricing Model</Label>
                <select
                  value={form.pricingModel}
                  onChange={e => setForm(f => ({ ...f, pricingModel: e.target.value }))}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {PRICING_MODELS.map(m => (
                    <option key={m.value} value={m.value}>{m.label}</option>
                  ))}
                </select>
              </div>
            </div>

            <div className="space-y-1.5">
              <Label>Target Audience</Label>
              <Textarea
                value={form.targetAudience}
                onChange={e => setForm(f => ({ ...f, targetAudience: e.target.value }))}
                placeholder="Who buys this product? e.g., Mid-market SaaS companies looking to scale"
                rows={2}
              />
            </div>

            <div className="space-y-1.5">
              <Label>Pain Points Solved</Label>
              <Input
                value={form.painPointsSolved}
                onChange={e => setForm(f => ({ ...f, painPointsSolved: e.target.value }))}
                placeholder="Comma-separated: Slow deployments, Manual testing, High infrastructure costs"
              />
              {splitTags(form.painPointsSolved).length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {splitTags(form.painPointsSolved).map((p, i) => (
                    <Badge key={i} variant="warning" className="text-xs">{p}</Badge>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Key Features</Label>
              <Input
                value={form.keyFeatures}
                onChange={e => setForm(f => ({ ...f, keyFeatures: e.target.value }))}
                placeholder="Comma-separated: Auto-scaling, Real-time monitoring, One-click deploy"
              />
              {splitTags(form.keyFeatures).length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {splitTags(form.keyFeatures).map((f, i) => (
                    <Badge key={i} variant="outline" className="text-xs">{f}</Badge>
                  ))}
                </div>
              )}
            </div>

            <div className="space-y-1.5">
              <Label>Differentiators</Label>
              <Input
                value={form.differentiators}
                onChange={e => setForm(f => ({ ...f, differentiators: e.target.value }))}
                placeholder="Comma-separated: AI-powered, 24/7 support, SOC2 certified"
              />
            </div>

            <div className="space-y-1.5">
              <Label>Pricing Details</Label>
              <Input
                value={form.pricingDetails}
                onChange={e => setForm(f => ({ ...f, pricingDetails: e.target.value }))}
                placeholder="e.g., Starting at $99/mo per seat"
              />
            </div>

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" size="sm">Cancel</Button>
              </DialogClose>
              <Button
                type="submit"
                size="sm"
                disabled={createProduct.isPending || updateProduct.isPending}
              >
                {(createProduct.isPending || updateProduct.isPending) ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : null}
                {editingProduct ? 'Update Product' : 'Create Product'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
