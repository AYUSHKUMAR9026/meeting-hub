/** A text field from FormData ('' when missing or a file). */
export function formValue(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}
