/**
 * Inline-editor bindings: the attributes that make a value editable on the page.
 *
 * Justmade Studio edits a site ON the site: the team in the studio's preview,
 * the customer in the client portal's visual editor. Both load this site in an
 * iframe, where the `sl.js` embed (see Base.astro) finds the elements tagged
 * below and makes them editable. An element without a tag is simply not
 * editable, so a value you forget to tag is one the customer cannot change.
 *
 * Spread the result onto the element that renders the value, right where the
 * data is bound, so the path can never drift from the value next to it:
 *
 *   <h1 {...slContent('site', 'home', 'title')}>{home.data.title}</h1>
 *   <ul {...slCollection('blog', 'posts')}>
 *     {posts.map((p) => (
 *       <li {...slItem(p.uid)}>
 *         <h2 {...slContent('blog', 'posts', 'title', p.uid)}>{p.data.title}</h2>
 *       </li>
 *     ))}
 *   </ul>
 *
 * Rules the editor holds you to (it disables a binding that breaks them):
 *   - The element renders the RAW stored value. A formatted date, a cut-off
 *     excerpt or rendered markdown binds read-only: writing the rendered text
 *     back would corrupt the record. Tag a raw element, or leave it untagged.
 *   - One path, one element. Rendering a value twice? Tag one of them.
 *   - A list field gets an index per entry (`tags[0]`, `members[1].name`):
 *     the bare field addresses the whole array, which no element renders.
 *   - Inline text editing covers text, plain textarea, email, url and number
 *     fields. Images are swapped in place; a gallery (`multiple`) entry only when
 *     the site renders the stored CDN URL, which a /cdn/ url is not, so gallery
 *     images are changed in the CMS.
 */

type Attrs = Record<string, string>;

/**
 * `data-sl-content`: the record and field a value came from.
 *
 * Leave `recordUid` out for a SINGLE dataset (its one record is implied); a
 * COLLECTION needs it. `field` may nest and index: `seo.title`, `tags[0]`.
 */
export function slContent(node: string, dataset: string, field: string, recordUid?: string): Attrs {
  const record = recordUid ? `[${recordUid}]` : '';
  return { 'data-sl-content': `${node}.${dataset}${record}.${field}` };
}

/**
 * `data-sl-collection`: the wrapper of a list rendered from a collection
 * dataset, so people can add, delete and reorder records from the page.
 * Reordering is only offered when the page shows the records in stored order.
 */
export function slCollection(node: string, dataset: string): Attrs {
  return { 'data-sl-collection': `${node}.${dataset}` };
}

/** `data-sl-item`: one repeated element inside a `slCollection` wrapper. */
export function slItem(recordUid: string): Attrs {
  return { 'data-sl-item': recordUid };
}
