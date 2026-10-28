// Lazy, collapsible JSON tree plus a path search. Children are only built when a
// node is first opened, so multi-MB page-module responses stay responsive.

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export function childPath(parent, key) {
  if (typeof key === 'number') return `${parent}[${key}]`;
  if (IDENTIFIER.test(key)) return parent ? `${parent}.${key}` : key;
  return `${parent}[${JSON.stringify(key)}]`;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function preview(value) {
  if (Array.isArray(value)) return `Array(${value.length})`;
  const keys = Object.keys(value);
  const shown = keys.slice(0, 4).join(', ');
  return `{${shown}${keys.length > 4 ? ', …' : ''}}`;
}

function primitive(value) {
  if (value === null) return el('span', 'jv-null', 'null');
  if (typeof value === 'string') return el('span', 'jv-string', JSON.stringify(value));
  if (typeof value === 'number') return el('span', 'jv-number', String(value));
  if (typeof value === 'boolean') return el('span', 'jv-boolean', String(value));
  return el('span', 'jv-null', String(value));
}

function keyLabel(key, path, onKeyClick) {
  const label = el('button', 'jv-key', typeof key === 'number' ? String(key) : key);
  label.type = 'button';
  label.title = `Copy path: ${path || '(root)'}`;
  label.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onKeyClick?.(path);
  });
  return label;
}

function buildNode(key, value, path, depth, options) {
  const isContainer = value !== null && typeof value === 'object';
  if (!isContainer) {
    const row = el('div', 'jv-row');
    if (key !== undefined) row.append(keyLabel(key, path, options.onKeyClick), el('span', 'jv-colon', ': '));
    row.append(primitive(value));
    return row;
  }

  const details = el('details', 'jv-node');
  const summary = el('summary');
  if (key !== undefined) summary.append(keyLabel(key, path, options.onKeyClick), el('span', 'jv-colon', ': '));
  summary.append(el('span', 'jv-preview', preview(value)));
  details.append(summary);

  let built = false;
  const build = () => {
    if (built) return;
    built = true;
    const children = el('div', 'jv-children');
    const entries = Array.isArray(value) ? value.map((item, index) => [index, item]) : Object.entries(value);
    for (const [childKey, childValue] of entries) {
      children.append(buildNode(childKey, childValue, childPath(path, childKey), depth + 1, options));
    }
    details.append(children);
  };
  details.addEventListener('toggle', () => {
    if (details.open) build();
  });
  if (depth < options.expandDepth) {
    build();
    details.open = true;
  }
  return details;
}

export function renderJsonTree(value, { expandDepth = 2, onKeyClick } = {}) {
  const root = el('div', 'jv-root');
  root.append(buildNode(undefined, value, '', 0, { expandDepth, onKeyClick }));
  return root;
}

// Finds keys or primitive values containing `query`. Returns [{ path, value }].
export function searchJson(value, query, limit = 200) {
  const needle = query.trim().toLowerCase();
  const results = [];
  if (!needle) return results;

  const stack = [['', value, undefined]];
  while (stack.length && results.length < limit) {
    const [path, current, key] = stack.pop();
    const keyHit = key !== undefined && String(key).toLowerCase().includes(needle);
    if (current !== null && typeof current === 'object') {
      if (keyHit) results.push({ path, value: preview(current) });
      const entries = Array.isArray(current) ? current.map((item, index) => [index, item]) : Object.entries(current);
      for (let i = entries.length - 1; i >= 0; i--) {
        const [childKey, childValue] = entries[i];
        stack.push([childPath(path, childKey), childValue, childKey]);
      }
    } else if (keyHit || String(current).toLowerCase().includes(needle)) {
      results.push({ path, value: JSON.stringify(current) });
    }
  }
  return results;
}

export function getAtPath(value, path) {
  if (!path) return value;
  const tokens = path.match(/[A-Za-z_$][\w$]*|\[\d+\]|\["(?:[^"\\]|\\.)*"\]/g) ?? [];
  let current = value;
  for (const token of tokens) {
    if (current == null) return undefined;
    if (token.startsWith('["')) current = current[JSON.parse(token.slice(1, -1))];
    else if (token.startsWith('[')) current = current[Number(token.slice(1, -1))];
    else current = current[token];
  }
  return current;
}
