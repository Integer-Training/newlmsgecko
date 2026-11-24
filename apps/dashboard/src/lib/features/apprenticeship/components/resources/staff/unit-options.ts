import type { ProgrammeTree } from '../../../api/programmes.svelte';
import type { PickerQualification } from '../../../api/evidence.svelte';

/** Every unit of the programme, in order, for the "Unit" select. */
export function unitOptions(tree: ProgrammeTree | null): { id: string; label: string }[] {
  if (!tree) return [];
  return tree.qualifications.flatMap((q) =>
    q.units.map((u) => ({ id: u.id, label: u.code ? `${u.code} · ${u.title}` : u.title }))
  );
}

/** The programme's criteria across ALL units, in the shape the criteria picker takes. */
export function pickerTreeOf(tree: ProgrammeTree | null): PickerQualification[] {
  if (!tree) return [];
  return tree.qualifications.map((q) => ({
    id: q.id,
    title: q.title,
    units: q.units.map((u) => ({
      id: u.id,
      code: u.code,
      title: u.title,
      criteria: u.criteria.map((c) => ({ id: c.id, code: c.code, text: c.text }))
    }))
  }));
}

/** File name without its extension, for a default title. */
export function titleFromFile(name: string): string {
  return name
    .replace(/\.[^.]+$/, '')
    .replace(/_+/g, ' ')
    .trim();
}
