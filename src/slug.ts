/**
 * Slug helpers shared by the watch and summary features.
 *
 * Both derive a filesystem-safe id from human text the caller supplies, and both
 * have to cope with Cyrillic: a plain ASCII-only slug regex would reduce "Москва"
 * to an empty string and silently fall back to a generic id. Transliterating first
 * keeps "moskva", which is what shows up in file names and in every later tool
 * call.
 */

const CYRILLIC: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z',
  и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r',
  с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh',
  щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

export function transliterate(value: string): string {
  let output = '';
  for (const character of value.toLowerCase()) {
    output += CYRILLIC[character] ?? character;
  }
  return output;
}

/**
 * Lower-case, hyphen-separated ASCII slug.
 *
 * Returns an empty string when nothing survives (a title written entirely in a
 * script this does not transliterate), leaving the caller to choose its own
 * fallback rather than silently getting the word "untitled".
 */
export function slugify(value: string, maxLength = 64): string {
  return transliterate(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}
