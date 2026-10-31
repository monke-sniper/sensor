// Layout tree for a workspace. Pure functions so the shell renderer and the
// core can share them and they can be unit tested.

export type ToolKind =
  | 'notes'
  | 'files'
  | 'downloads'
  | 'history'
  | 'bookmarks'
  | 'rss'
  | 'clipboard'
  | 'macros'
  | 'search'
  | 'terminal'
  | 'agents'
  | 'projects'
  | 'obsidian'
  | 'settings'
  | 'notifications'
  | 'annotations'
  | 'documents'
  | 'providers'
  | 'ai'
  | 'backups';

export type Panel =
  | { kind: 'browser' } // shows the workspace's active tab
  | { kind: 'web'; tabId: string } // a website pinned as a persistent panel
  | { kind: 'tool'; tool: ToolKind; state?: Record<string, any> };

export type LayoutNode =
  | { type: 'split'; id: string; dir: 'row' | 'col'; children: LayoutNode[]; sizes: number[] }
  | { type: 'leaf'; id: string; panel: Panel };

export interface FloatingPanel {
  id: string;
  tabId: string;
  bounds: { x: number; y: number; width: number; height: number };
  alwaysOnTop?: boolean;
}

export interface Layout {
  root: LayoutNode;
  floating: FloatingPanel[];
  sidebar: { visible: boolean; width: number };
}

let n = 0;
export function nodeId(): string {
  n = (n + 1) % 1e6;
  return 'n' + Date.now().toString(36) + n.toString(36);
}

export function defaultLayout(): Layout {
  return {
    root: { type: 'leaf', id: nodeId(), panel: { kind: 'browser' } },
    floating: [],
    sidebar: { visible: true, width: 240 },
  };
}

export function findNode(root: LayoutNode, id: string): LayoutNode | null {
  if (root.id === id) return root;
  if (root.type === 'split') {
    for (const c of root.children) {
      const f = findNode(c, id);
      if (f) return f;
    }
  }
  return null;
}

export function leaves(root: LayoutNode): Extract<LayoutNode, { type: 'leaf' }>[] {
  if (root.type === 'leaf') return [root];
  return root.children.flatMap(leaves);
}

export function findLeafBy(root: LayoutNode, pred: (p: Panel) => boolean) {
  return leaves(root).find((l) => pred(l.panel)) ?? null;
}

export type Side = 'left' | 'right' | 'top' | 'bottom';

/** Insert a new leaf next to `targetId` (or next to the root when omitted). Returns the new tree. */
export function insertPanel(root: LayoutNode, panel: Panel, side: Side = 'right', targetId?: string, size = 0.35): { root: LayoutNode; leafId: string } {
  const leaf: LayoutNode = { type: 'leaf', id: nodeId(), panel };
  const dir: 'row' | 'col' = side === 'left' || side === 'right' ? 'row' : 'col';
  const before = side === 'left' || side === 'top';
  const target = targetId ? findNode(root, targetId) : root;
  if (!target) throw new Error(`layout node not found: ${targetId}`);

  const wrap = (node: LayoutNode): LayoutNode => {
    const children = before ? [leaf, node] : [node, leaf];
    const sizes = before ? [size, 1 - size] : [1 - size, size];
    return { type: 'split', id: nodeId(), dir, children, sizes };
  };

  if (target === root) return { root: wrap(root), leafId: leaf.id };

  const replace = (node: LayoutNode): LayoutNode => {
    if (node.type !== 'split') return node;
    const idx = node.children.findIndex((c) => c.id === target.id);
    if (idx >= 0) {
      // Same direction: add as a sibling instead of nesting.
      if (node.dir === dir) {
        const children = [...node.children];
        const sizes = [...node.sizes];
        const share = sizes[idx] * size;
        sizes[idx] -= share;
        const at = before ? idx : idx + 1;
        children.splice(at, 0, leaf);
        sizes.splice(at, 0, share);
        return { ...node, children, sizes };
      }
      const children = [...node.children];
      children[idx] = wrap(target);
      return { ...node, children };
    }
    return { ...node, children: node.children.map(replace) };
  };
  return { root: replace(root), leafId: leaf.id };
}

/** Remove a leaf; its sibling takes its space. The last leaf cannot be removed. */
export function removeNode(root: LayoutNode, id: string): LayoutNode {
  if (root.id === id) return root;
  const rec = (node: LayoutNode): LayoutNode => {
    if (node.type !== 'split') return node;
    const idx = node.children.findIndex((c) => c.id === id);
    if (idx >= 0) {
      const children = node.children.filter((_, i) => i !== idx);
      const removed = node.sizes[idx];
      const sizes = node.sizes.filter((_, i) => i !== idx);
      const total = sizes.reduce((a, b) => a + b, 0) || 1;
      const norm = sizes.map((s) => s / total);
      void removed;
      if (children.length === 1) return children[0];
      return { ...node, children, sizes: norm };
    }
    return { ...node, children: node.children.map(rec) };
  };
  return rec(root);
}

export function setSizes(root: LayoutNode, splitId: string, sizes: number[]): LayoutNode {
  const rec = (node: LayoutNode): LayoutNode => {
    if (node.type !== 'split') return node;
    if (node.id === splitId) {
      if (sizes.length !== node.children.length) throw new Error('sizes length mismatch');
      const total = sizes.reduce((a, b) => a + b, 0);
      return { ...node, sizes: sizes.map((s) => s / total) };
    }
    return { ...node, children: node.children.map(rec) };
  };
  return rec(root);
}

export function replacePanel(root: LayoutNode, leafId: string, panel: Panel): LayoutNode {
  const rec = (node: LayoutNode): LayoutNode => {
    if (node.type === 'leaf') return node.id === leafId ? { ...node, panel } : node;
    return { ...node, children: node.children.map(rec) };
  };
  return rec(root);
}

/** Tab ids that are visible given a layout and the workspace's active tab. */
export function visibleTabIds(layout: Layout, activeTab: string | null): string[] {
  const ids = new Set<string>();
  for (const l of leaves(layout.root)) {
    if (l.panel.kind === 'browser' && activeTab) ids.add(activeTab);
    if (l.panel.kind === 'web') ids.add(l.panel.tabId);
  }
  for (const f of layout.floating) ids.add(f.tabId);
  return [...ids];
}
