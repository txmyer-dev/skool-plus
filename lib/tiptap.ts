// TipTap / ProseMirror JSON → markdown. Skool stores classroom lesson bodies as
// "[v2]" + JSON (an array of block nodes, or a {type:'doc'} object).

type Node = { type?: string; text?: string; attrs?: Record<string, any>; marks?: Array<{ type: string; attrs?: Record<string, any> }>; content?: Node[] };

export function parseTiptap(desc: string | undefined): Node[] | undefined {
  if (!desc) return undefined;
  const raw = desc.startsWith('[v2]') ? desc.slice(4) : desc;
  try {
    const j = JSON.parse(raw);
    if (Array.isArray(j)) return j;
    if (j && typeof j === 'object') return j.type === 'doc' ? j.content ?? [] : [j];
  } catch {
    /* not JSON */
  }
  return undefined;
}

export function tiptapToMarkdown(desc: string | undefined): string {
  const nodes = parseTiptap(desc);
  if (!nodes) return (desc ?? '').trim();
  return nodes.map((n) => block(n, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function inline(nodes: Node[] | undefined): string {
  return (nodes ?? []).map(inlineNode).join('');
}

function inlineNode(n: Node): string {
  switch (n.type) {
    case 'text': {
      let t = n.text ?? '';
      for (const m of n.marks ?? []) {
        if (m.type === 'bold') t = `**${t}**`;
        else if (m.type === 'italic') t = `_${t}_`;
        else if (m.type === 'code') t = `\`${t}\``;
        else if (m.type === 'strike') t = `~~${t}~~`;
        else if (m.type === 'link' && m.attrs?.href) t = `[${t}](${m.attrs.href})`;
      }
      return t;
    }
    case 'hardBreak':
      return '\n';
    case 'mention':
      return `@${n.attrs?.label ?? n.attrs?.id ?? ''}`;
    case 'image':
      return `![${n.attrs?.alt ?? ''}](${n.attrs?.src ?? ''})`;
    case 'emoji':
      return n.attrs?.emoji ?? n.attrs?.name ?? '';
    default:
      if (n.content) return inline(n.content);
      return n.attrs?.src || n.attrs?.href ? `${n.attrs.src ?? n.attrs.href}` : n.text ?? '';
  }
}

function block(n: Node, indent: string): string {
  switch (n.type) {
    case 'paragraph':
      return `${indent}${inline(n.content).replace(/\n/g, `\n${indent}`)}\n`;
    case 'heading':
      return `${indent}${'#'.repeat(Math.min(6, n.attrs?.level ?? 1))} ${inline(n.content)}\n`;
    case 'codeBlock':
      return `${indent}\`\`\`${n.attrs?.language ?? ''}\n${(n.content ?? []).map((c) => c.text ?? '').join('')}\n${indent}\`\`\`\n`;
    case 'blockquote':
      return (n.content ?? []).map((c) => block(c, '')).join('\n').replace(/\n+$/, '').split('\n').map((l) => (l ? `${indent}> ${l}` : `${indent}>`)).join('\n') + '\n';
    case 'bulletList':
    case 'orderedList': {
      const start = n.attrs?.start ?? 1;
      return (n.content ?? [])
        .map((item, i) => {
          const marker = n.type === 'orderedList' ? `${start + i}. ` : '- ';
          const parts = (item.content ?? []).map((c, j) => (j === 0 && c.type === 'paragraph' ? `${indent}${marker}${inline(c.content)}\n` : block(c, `${indent}${' '.repeat(marker.length)}`)));
          return parts.join('');
        })
        .join('');
    }
    case 'horizontalRule':
      return `${indent}---\n`;
    case 'image':
      return `${indent}![${n.attrs?.alt ?? ''}](${n.attrs?.src ?? ''})\n`;
    case 'youtube':
    case 'video':
    case 'iframe':
    case 'embed':
      return `${indent}${n.attrs?.src ?? n.attrs?.url ?? ''}\n`;
    case 'table':
      return (n.content ?? []).map((row, r) => {
        const cells = (row.content ?? []).map((c) => inline(c.content?.flatMap((p) => p.content ?? []) ?? []).replace(/\n/g, ' '));
        const line = `${indent}| ${cells.join(' | ')} |\n`;
        return r === 0 ? `${line}${indent}| ${cells.map(() => '---').join(' | ')} |\n` : line;
      }).join('') + '\n';
    default:
      if (n.content) return n.content.map((c) => block(c, indent)).join('\n');
      return inlineNode(n) ? `${indent}${inlineNode(n)}\n` : '';
  }
}
