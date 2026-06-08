import { load } from 'cheerio';
import { StackItem } from '../pipeline/stack';
type SelectorTypes = 'stylesheets' | 'scripts' | 'imports' | 'preloadScripts' | 'preload' | 'links' | 'images'
type SelectorAccessor = {
  selector: string;
  attribute: 'href' | 'src';
}
type SelectorMap = Record<SelectorTypes, SelectorAccessor>
const selectors: SelectorMap = {
  stylesheets: {
    selector: 'link[rel="stylesheet"]',
    attribute: 'href',
  },
  scripts: {
    selector: 'script',
    attribute: 'src',
  },
  imports: {
    selector: 'link[rel="import"]',
    attribute: 'href',
  },
  preloadScripts: {
    selector: 'link[rel="preload"][as="script"]',
    attribute: 'href',
  },
  preload: {
    selector: 'link[rel="preload"][as="style"]',
    attribute: 'href',
  },
  links: {
    selector: 'a',
    attribute: 'href',
  },
  images: {
    selector: 'img',
    attribute: 'src',
  },
};

const loadExtract = (src: StackItem, types: SelectorTypes[] = []) => {
  if (types.length == 0) {
    return [];
  }
  const $ = load(src.data);
  console.log({ types });
  const results = types.map((t) => {
    const chosenType = selectors[t];
    const resSel = $(chosenType.selector);
    if (resSel) {
      return Array.prototype.map.call(resSel, (el) => {
        const $el = $(el);
        const r = new URL(
          $el.attr(chosenType.attribute) as string,
          src.path,
        ).toString();
        console.log('lnk', r);
        return r.replace(/[?].*/, '') as string;
        // if (raw) {
        //     return {
        //         $el,
        //         value: $el.attr(chosenType.attribute)
        //     };
        // }
      })
        // TODO: no idea how this works
        .reduce(
          (r: any, l: any) =>
            (r.includes(l) || l.endsWith('undefined')) ? r : [...r, l],
          [],
        ) as string[];
    } else {
      return [] as string[];
    }
  });
  return results.reduce((r, a) => r.concat(a), []) as string[];
};

export const extractSourceLinks = (raw: string) => {
  const re = /(http[s]?:\/\/)?[^\s(["<,>]*\.[^\s[",><]*/igm;
  return raw.match(re)?.filter((m) => (/http.*\.(js|css)$/.test(m)));
};

// export const oust = (src, type) => {
//   if (!src || !type) {
//     throw new Error('`src` and `type` required');
//   }

//   const validTypes = Object.keys(types);

//   if (!validTypes.includes(type)) {
//     throw new Error(
//         `Invalid \`type\` value "${type}". `+
//         `Choose one of: ${validTypes.join(', ')}`,
//     );
//   }

//   return loadExtract(src, [type]);
// };

export const extractRawHtml = (src: { data: string, path: string }) => {
  return loadExtract(src, [
    'stylesheets',
    'scripts',
    'imports',
    'preloadScripts',
    'preload',
  ]);
};

export const isHtml = (s: string) => {
  // eslint-disable-next-line max-len
  return /<(br|basefont|hr|input|source|frame|param|area|meta|!--|col|link|option|base|img|wbr|!DOCTYPE).*?>|<(a|abbr|acronym|address|applet|article|aside|audio|b|bdi|bdo|big|blockquote|body|button|canvas|caption|center|cite|code|colgroup|command|datalist|dd|del|details|dfn|dialog|dir|div|dl|dt|em|embed|fieldset|figcaption|figure|font|footer|form|frameset|head|header|hgroup|h1|h2|h3|h4|h5|h6|html|i|iframe|ins|kbd|keygen|label|legend|li|map|mark|menu|meter|nav|noframes|noscript|object|ol|optgroup|output|p|pre|progress|q|rp|rt|ruby|s|samp|script|section|select|small|span|strike|strong|style|sub|summary|sup|table|tbody|td|textarea|tfoot|th|thead|time|title|tr|track|tt|u|ul|var|video).*?<\/\2>/i.test(s);
};

export default extractRawHtml;
