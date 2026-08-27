'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

/**
 * The model occasionally escapes emphasis markers or emits a compact table
 * while streaming. Normalise those harmless variants before GFM parses it.
 */
function normaliseModelMarkdown(value: string) {
  const text = String(value || '')
    .normalize('NFKC')
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
    .replace(/\\+(\*)/g, '$1')
    .replace(/\r\n?/g, '\n');

  const hasTable = /^\s*\|.+\|\s*$/m.test(text) && /\|\s*:?-{3,}/.test(text);
  if (!hasTable) return text;

  // Repair `| heading || --- || row |` into the line-oriented form required
  // by GFM. Empty cells are left alone unless the text clearly is a table.
  return text.replace(/\|\|\s*(?=(?::?-{3,}|[^|\n]+\|))/g, '|\n|');
}

export default function MarkdownContent({ value, className = '' }: { value: string; className?: string }) {
  return (
    <div className={`markdown-content ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
          code: ({ className: codeClassName, children, ...props }) => {
            const inline = !codeClassName;
            return inline
              ? <code {...props}>{children}</code>
              : <code className={codeClassName} {...props}>{children}</code>;
          },
        }}
      >
        {normaliseModelMarkdown(value)}
      </ReactMarkdown>
    </div>
  );
}
