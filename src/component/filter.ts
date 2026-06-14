import type { QueryCtx } from "./_generated/server";

export type Predicate = (stored: Record<string, unknown>) => boolean;
export type FieldType = "string" | "number";

export type Ast =
  | { kind: "and"; left: Ast; right: Ast }
  | { kind: "or"; left: Ast; right: Ast }
  | { kind: "exact"; field: string; type: FieldType; value: string }
  | { kind: "inSet"; field: string; type: FieldType; values: string[] }
  | { kind: "cmp"; field: string; op: ">" | ">=" | "<" | "<="; num: number }
  | { kind: "range"; field: string; lo: number; hi: number };

type Tok = { t: string; v?: string };

function tokenize(s: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const special = new Set([" ", "\t", "\n", "(", ")", "[", "]", ",", ":", ">", "<", '"']);
  while (i < s.length) {
    const c = s[i];
    if (c === " " || c === "\t" || c === "\n") { i++; continue; }
    const two = s.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === ".." || two === ">=" || two === "<=") {
      toks.push({ t: two });
      i += 2;
      continue;
    }
    if ("()[],:><".includes(c)) { toks.push({ t: c }); i++; continue; }
    if (c === '"') {
      let j = i + 1;
      let val = "";
      while (j < s.length && s[j] !== '"') { val += s[j]; j++; }
      if (j >= s.length) throw new Error("Unterminated quote in filter");
      toks.push({ t: "val", v: val });
      i = j + 1;
      continue;
    }
    let j = i;
    let val = "";
    while (j < s.length) {
      if (special.has(s[j])) break;
      const t2 = s.slice(j, j + 2);
      if (t2 === "&&" || t2 === "||" || t2 === "..") break;
      val += s[j];
      j++;
    }
    if (val === "") throw new Error(`Unexpected character '${s[i]}' in filter`);
    toks.push({ t: "val", v: val });
    i = j;
  }
  return toks;
}

export function parseFilterAst(
  input: string,
  fieldTypes: Record<string, FieldType>,
): Ast {
  const toks = tokenize(input);
  let pos = 0;
  const peek = () => toks[pos];
  const next = () => toks[pos++];
  const expect = (t: string) => {
    const x = next();
    if (!x || x.t !== t) throw new Error(`Expected '${t}' in filter`);
    return x;
  };
  const getVal = (): string => {
    const x = next();
    if (!x || x.t !== "val") throw new Error("Expected a value in filter");
    return x.v!;
  };

  function parseExpr(): Ast {
    let left = parseAnd();
    while (peek() && peek().t === "||") {
      next();
      left = { kind: "or", left, right: parseAnd() };
    }
    return left;
  }
  function parseAnd(): Ast {
    let left = parseUnary();
    while (peek() && peek().t === "&&") {
      next();
      left = { kind: "and", left, right: parseUnary() };
    }
    return left;
  }
  function parseUnary(): Ast {
    if (peek() && peek().t === "(") {
      next();
      const e = parseExpr();
      expect(")");
      return e;
    }
    return parseClause();
  }
  function parseClause(): Ast {
    const f = next();
    if (!f || f.t !== "val") throw new Error("Expected a field name in filter");
    const field = f.v!;
    const type = fieldTypes[field];
    if (!type) throw new Error(`Unknown filter field: ${field}`);
    expect(":");
    return parseMatcher(field, type);
  }
  function parseMatcher(field: string, type: FieldType): Ast {
    const p = peek();
    if (p && p.t === "[") {
      next();
      const first = getVal();
      if (peek() && peek().t === "..") {
        next();
        const second = getVal();
        expect("]");
        if (type !== "number") throw new Error(`Range filter requires a numeric field: ${field}`);
        const lo = Number(first), hi = Number(second);
        if (Number.isNaN(lo) || Number.isNaN(hi)) throw new Error(`Invalid numeric range for ${field}`);
        return { kind: "range", field, lo, hi };
      }
      const values = [first];
      while (peek() && peek().t === ",") { next(); values.push(getVal()); }
      expect("]");
      if (type === "number") {
        for (const x of values) {
          if (Number.isNaN(Number(x))) throw new Error(`Invalid number in filter for ${field}: ${x}`);
        }
      }
      return { kind: "inSet", field, type, values };
    }
    if (p && (p.t === ">" || p.t === ">=" || p.t === "<" || p.t === "<=")) {
      const op = next().t as ">" | ">=" | "<" | "<=";
      if (type !== "number") throw new Error(`Comparator filter requires a numeric field: ${field}`);
      const num = Number(getVal());
      if (Number.isNaN(num)) throw new Error(`Invalid number in filter for ${field}`);
      return { kind: "cmp", field, op, num };
    }
    const val = getVal();
    if (type === "number" && Number.isNaN(Number(val))) {
      throw new Error(`Invalid number in filter for ${field}: ${val}`);
    }
    return { kind: "exact", field, type, value: val };
  }

  const ast = parseExpr();
  if (pos !== toks.length) throw new Error("Unexpected trailing tokens in filter");
  return ast;
}

export function astToPredicate(ast: Ast): Predicate {
  switch (ast.kind) {
    case "and": {
      const l = astToPredicate(ast.left), r = astToPredicate(ast.right);
      return (d) => l(d) && r(d);
    }
    case "or": {
      const l = astToPredicate(ast.left), r = astToPredicate(ast.right);
      return (d) => l(d) || r(d);
    }
    case "exact": {
      if (ast.type === "number") {
        const n = Number(ast.value);
        return (d) => { const v = Number(d[ast.field]); return !Number.isNaN(v) && v === n; };
      }
      return (d) => d[ast.field] !== undefined && String(d[ast.field]) === ast.value;
    }
    case "inSet": {
      if (ast.type === "number") {
        const nums = ast.values.map((x) => Number(x));
        return (d) => { const v = Number(d[ast.field]); return !Number.isNaN(v) && nums.includes(v); };
      }
      return (d) => d[ast.field] !== undefined && ast.values.includes(String(d[ast.field]));
    }
    case "cmp": {
      const { field, op, num } = ast;
      return (d) => {
        const v = Number(d[field]);
        if (Number.isNaN(v)) return false;
        return op === ">" ? v > num : op === ">=" ? v >= num : op === "<" ? v < num : v <= num;
      };
    }
    case "range": {
      const { field, lo, hi } = ast;
      return (d) => { const v = Number(d[field]); return !Number.isNaN(v) && v >= lo && v <= hi; };
    }
  }
}

export function parseFilter(input: string, fieldTypes: Record<string, FieldType>): Predicate {
  return astToPredicate(parseFilterAst(input, fieldTypes));
}

async function strIds(ctx: QueryCtx, collection: string, field: string, value: string): Promise<string[]> {
  const rows = await ctx.db
    .query("filters")
    .withIndex("by_str", (q) => q.eq("collection", collection).eq("field", field).eq("strVal", value))
    .collect();
  return rows.map((r) => r.docId);
}
async function numEqIds(ctx: QueryCtx, collection: string, field: string, num: number): Promise<string[]> {
  const rows = await ctx.db
    .query("filters")
    .withIndex("by_num", (q) => q.eq("collection", collection).eq("field", field).eq("numVal", num))
    .collect();
  return rows.map((r) => r.docId);
}
async function numCmpIds(ctx: QueryCtx, collection: string, field: string, op: string, num: number): Promise<string[]> {
  const rows = await ctx.db
    .query("filters")
    .withIndex("by_num", (q) => {
      const b = q.eq("collection", collection).eq("field", field);
      return op === ">" ? b.gt("numVal", num)
        : op === ">=" ? b.gte("numVal", num)
        : op === "<" ? b.lt("numVal", num)
        : b.lte("numVal", num);
    })
    .collect();
  return rows.map((r) => r.docId);
}
async function numRangeIds(ctx: QueryCtx, collection: string, field: string, lo: number, hi: number): Promise<string[]> {
  const rows = await ctx.db
    .query("filters")
    .withIndex("by_num", (q) => q.eq("collection", collection).eq("field", field).gte("numVal", lo).lte("numVal", hi))
    .collect();
  return rows.map((r) => r.docId);
}

export async function resolveAstToDocIds(
  ctx: QueryCtx,
  collection: string,
  ast: Ast,
): Promise<Set<string>> {
  switch (ast.kind) {
    case "and": {
      const a = await resolveAstToDocIds(ctx, collection, ast.left);
      const b = await resolveAstToDocIds(ctx, collection, ast.right);
      const [small, big] = a.size <= b.size ? [a, b] : [b, a];
      const out = new Set<string>();
      for (const id of small) if (big.has(id)) out.add(id);
      return out;
    }
    case "or": {
      const a = await resolveAstToDocIds(ctx, collection, ast.left);
      const b = await resolveAstToDocIds(ctx, collection, ast.right);
      for (const id of b) a.add(id);
      return a;
    }
    case "exact":
      return new Set(ast.type === "number"
        ? await numEqIds(ctx, collection, ast.field, Number(ast.value))
        : await strIds(ctx, collection, ast.field, ast.value));
    case "inSet": {
      const out = new Set<string>();
      for (const v of ast.values) {
        const ids = ast.type === "number"
          ? await numEqIds(ctx, collection, ast.field, Number(v))
          : await strIds(ctx, collection, ast.field, v);
        for (const id of ids) out.add(id);
      }
      return out;
    }
    case "cmp":
      return new Set(await numCmpIds(ctx, collection, ast.field, ast.op, ast.num));
    case "range":
      return new Set(await numRangeIds(ctx, collection, ast.field, ast.lo, ast.hi));
  }
}
