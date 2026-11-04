'use client';

import * as React from 'react';
import { useProducts, useCreateProduct, useUpdateProduct, useDeleteProduct, useSuggestProduct } from '@/hooks/use-products';
import { useAuthStore } from '@/stores/auth.store';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Button } from '@/components/ui/button';
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
import { Package, Plus, Loader2, Sparkles, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Product } from '@/types';

import { Select } from '@/components/ui/select';
import { useConfirm } from '@/components/ui/confirm-dialog';
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
  const confirm = useConfirm();
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

  async function handleDelete(product: Product) {
    const ok = await confirm({
      title: `Delete "${product.name}"?`,
      description: 'Agents will stop using it. This cannot be undone.',
      confirmLabel: 'Delete product',
    });
    if (!ok) return;
    try {
      const id = product.id;
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
      <div className="space-y-4">
        <Skeleton className="h-44 rounded-2xl" />
        <Skeleton className="h-9 w-40 rounded-lg" />
      </div>
    );
  }

  const list = products ?? [];
  const atLimit = count >= limit;
  const saving = createProduct.isPending || updateProduct.isPending;

  return (
    <div className="space-y-4">
      <section className="rounded-2xl border border-line bg-bg-panel shadow-sm">
        <header className="flex items-center justify-between gap-3 border-b border-line px-5 py-3.5">
          <div>
            <h2 className="m-0 text-body font-semibold text-ink">Products</h2>
            <p className="mb-0 mt-0.5 text-xs text-ink-3">What you sell. Agents quote this in their outreach.</p>
          </div>
          <span className="shrink-0 text-xs text-ink-3">
            {count} of {limit === Infinity ? 'unlimited' : limit} on your plan
          </span>
        </header>

        {count === 0 ? (
          <div className="px-5 py-14 text-center">
            <span className="mx-auto grid size-11 place-items-center rounded-xl bg-accent-weak text-accent">
              <Package size={20} />
            </span>
            <p className="mb-0 mt-3 text-body font-semibold text-ink">No products yet</p>
            <p className="mx-auto mb-4 mt-1 max-w-sm text-xs leading-relaxed text-ink-3">
              Add what you sell so agents can write about your real offer instead of sending generic messages.
            </p>
            <Button type="button" variant="brand" size="sm" onClick={openCreate}>
              <Plus size={14} /> Add your first product
            </Button>
          </div>
        ) : (
          <ul className="m-0 list-none divide-y divide-line p-0">
            {list.map((product) => {
              const features = product.keyFeatures ?? [];
              const pains = product.painPointsSolved ?? [];
              const diffs = product.differentiators ?? [];
              return (
                <li key={product.id} className="flex gap-3.5 px-5 py-4">
                  <span
                    className={cn(
                      'grid size-9 shrink-0 place-items-center rounded-xl',
                      product.isActive ? 'bg-accent-weak text-accent' : 'bg-bg-soft text-ink-4',
                    )}
                  >
                    <Package size={16} />
                  </span>

                  <div className={cn('min-w-0 flex-1 space-y-3', !product.isActive && 'opacity-70')}>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <span className="text-body font-semibold text-ink">{product.name}</span>
                      {!product.isActive && <span className="rounded-tag bg-bg-soft px-2 py-0.5 text-2xs font-medium text-ink-3">Inactive</span>}
                      {product.category && <span className="rounded-tag bg-accent-weak px-2 py-0.5 text-2xs font-medium text-accent-fg">{product.category}</span>}
                      {product.pricingModel && (
                        <span className="rounded-tag bg-bg-soft px-2 py-0.5 text-2xs capitalize text-ink-2">{product.pricingModel.replace(/_/g, ' ')}</span>
                      )}
                    </div>

                    {product.description && <p className="m-0 line-clamp-2 text-xs leading-relaxed text-ink-2">{product.description}</p>}

                    {(product.targetAudience || product.pricingDetails) && (
                      <dl className="m-0 grid gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
                        {product.targetAudience && (
                          <div className="min-w-0">
                            <dt className="text-3xs font-medium uppercase tracking-[0.09em] text-ink-4">Who it&apos;s for</dt>
                            <dd className="m-0 mt-0.5 line-clamp-2 text-ink-2">{product.targetAudience}</dd>
                          </div>
                        )}
                        {product.pricingDetails && (
                          <div className="min-w-0">
                            <dt className="text-3xs font-medium uppercase tracking-[0.09em] text-ink-4">Pricing</dt>
                            <dd className="m-0 mt-0.5 line-clamp-2 text-ink-2">{product.pricingDetails}</dd>
                          </div>
                        )}
                      </dl>
                    )}

                    <TagRow label="What it does" items={features} tone="accent" />
                    <TagRow label="Pain points it answers" items={pains} tone="warn" />
                    <TagRow label="Why it wins" items={diffs} tone="neutral" />
                  </div>

                  <div className="flex shrink-0 items-start gap-1">
                    <Button type="button" variant="panel" size="dense" onClick={() => openEdit(product)} className="h-7 rounded-lg">
                      Edit
                    </Button>
                    <button
                      type="button"
                      onClick={() => handleToggleActive(product)}
                      disabled={updateProduct.isPending}
                      className="h-7 rounded-lg px-2 text-xs font-medium text-ink-2 hover:bg-hover disabled:opacity-50"
                    >
                      {product.isActive ? 'Disable' : 'Enable'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(product)}
                      disabled={deleteProduct.isPending}
                      className="h-7 rounded-lg px-2 text-xs font-medium text-ink-3 hover:bg-hover hover:text-down disabled:opacity-50"
                    >
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {count > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <Button type="button" variant={atLimit ? 'panel' : 'brand'} size="sm" onClick={openCreate} disabled={atLimit}>
            <Plus size={14} /> {atLimit ? `Add product — plan limit, ${count} of ${limit}` : 'Add product'}
          </Button>
          {atLimit && limit !== Infinity && <span className="text-xs text-ink-3">More products need a higher plan.</span>}
        </div>
      )}

      {/* Add/Edit Dialog */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editingProduct ? 'Edit product' : 'Add product'}</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-1.5">
              <Label>Product name *</Label>
              <div className="flex gap-2">
                <Input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="e.g., Cloud Migration Service"
                  required
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="panel"
                  size="sm"
                  onClick={handleAiSuggest}
                  disabled={!form.name.trim() || suggestProduct.isPending}
                  className="shrink-0 gap-1.5 text-accent-fg"
                  title="Fill the other fields from the product name"
                >
                  {suggestProduct.isPending ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
                  AI suggest
                </Button>
              </div>
              <p className="m-0 text-xs text-ink-3">Type a name, then let AI draft the rest. You can edit everything.</p>
            </div>

            <FormGroup title="About">
              <div className="space-y-1.5">
                <Label>Description</Label>
                <Textarea
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="One or two sentences on what it is"
                  rows={3}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Who it&apos;s for</Label>
                <Textarea
                  value={form.targetAudience}
                  onChange={(e) => setForm((f) => ({ ...f, targetAudience: e.target.value }))}
                  placeholder="e.g., Mid-market SaaS companies looking to scale"
                  rows={2}
                />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label>Category</Label>
                  <Input
                    value={form.category}
                    onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
                    placeholder="e.g., SaaS, Consulting"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label>Pricing model</Label>
                  <Select
                    value={form.pricingModel}
                    onChange={(e) => setForm((f) => ({ ...f, pricingModel: e.target.value }))}
                    className="w-full"
                  >
                    {PRICING_MODELS.map((m) => (
                      <option key={m.value} value={m.value}>{m.label}</option>
                    ))}
                  </Select>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label>Pricing details</Label>
                <Input
                  value={form.pricingDetails}
                  onChange={(e) => setForm((f) => ({ ...f, pricingDetails: e.target.value }))}
                  placeholder="e.g., Starting at $99/mo per seat"
                />
              </div>
            </FormGroup>

            <FormGroup title="What agents say about it" hint="Separate items with commas. Agents quote these in outreach.">
              <TagField
                label="What it does"
                value={form.keyFeatures}
                onChange={(v) => setForm((f) => ({ ...f, keyFeatures: v }))}
                placeholder="Auto-scaling, Real-time monitoring, One-click deploy"
                tone="accent"
              />
              <TagField
                label="Pain points it answers"
                value={form.painPointsSolved}
                onChange={(v) => setForm((f) => ({ ...f, painPointsSolved: v }))}
                placeholder="Slow deployments, Manual testing, High infrastructure costs"
                tone="warn"
              />
              <TagField
                label="Why it wins"
                value={form.differentiators}
                onChange={(v) => setForm((f) => ({ ...f, differentiators: v }))}
                placeholder="AI-powered, 24/7 support, SOC2 certified"
                tone="neutral"
              />
            </FormGroup>

            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" size="sm">Cancel</Button>
              </DialogClose>
              <Button type="submit" variant="brand" size="sm" disabled={saving}>
                {saving && <Loader2 className="mr-2 size-4 animate-spin" />}
                {editingProduct ? 'Save changes' : 'Create product'}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}

type Tone = 'accent' | 'warn' | 'neutral';

const TONE_CLASS: Record<Tone, string> = {
  accent: 'bg-accent-weak text-accent-fg',
  warn: 'bg-warn/15 text-warn-fg',
  neutral: 'bg-bg-soft text-ink-2',
};

function Chip({ children, tone, onRemove }: { children: React.ReactNode; tone: Tone; onRemove?: () => void }) {
  return (
    <span className={cn('inline-flex items-center gap-1.5 rounded-tag px-2 py-1 text-xs', TONE_CLASS[tone])}>
      {tone === 'warn' && <span className="size-1.5 rounded-full bg-current opacity-70" />}
      {children}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={`Remove ${children}`}
          className="-mr-0.5 grid size-4 place-items-center rounded-full opacity-60 transition hover:bg-black/10 hover:opacity-100"
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}

function TagRow({ label, items, tone }: { label: string; items: string[]; tone: Tone }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="mb-1.5 text-3xs font-medium uppercase tracking-[0.09em] text-ink-4">{label}</div>
      <div className="flex flex-wrap gap-1.5">
        {items.map((t, i) => (
          <Chip key={`${t}-${i}`} tone={tone}>{t}</Chip>
        ))}
      </div>
    </div>
  );
}

function FormGroup({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <fieldset className="m-0 space-y-3.5 rounded-xl border border-line p-4">
      <legend className="px-1.5 text-3xs font-medium uppercase tracking-[0.09em] text-ink-3">{title}</legend>
      {hint && <p className="m-0 -mt-1 text-xs text-ink-3">{hint}</p>}
      {children}
    </fieldset>
  );
}

function TagField({
  label,
  value,
  onChange,
  placeholder,
  tone,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  tone: Tone;
}) {
  const tags = splitTags(value);
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} />
      {tags.length > 0 && (
        <div className="flex flex-wrap gap-1.5 pt-0.5">
          {tags.map((t, i) => (
            <Chip key={`${t}-${i}`} tone={tone} onRemove={() => onChange(tags.filter((_, j) => j !== i).join(', '))}>
              {t}
            </Chip>
          ))}
        </div>
      )}
    </div>
  );
}
