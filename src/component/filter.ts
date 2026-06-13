export type Predicate = (stored: Record<string, unknown>) => boolean;
export type FieldType = "string" | "number";

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

export function parseFilter(
  input: string,
  fieldTypes: Record<string, FieldType>,
): Predicate {
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

  function parseExpr(): Predicate {
    let left = parseAnd();
    while (peek() && peek().t === "||") {
      next();
      const right = parseAnd();
      const l = left, r = right;
      left = (d) => l(d) || r(d);
    }
    return left;
  }
  function parseAnd(): Predicate {
    let left = parseUnary();
    while (peek() && peek().t === "&&") {
      next();
      const right = parseUnary();
      const l = left, r = right;
      left = (d) => l(d) && r(d);
    }
    return left;
  }
  function parseUnary(): Predicate {
    if (peek() && peek().t === "(") {
      next();
      const e = parseExpr();
      expect(")");
      return e;
    }
    return parseClause();
  }
  function parseClause(): Predicate {
    const f = next();
    if (!f || f.t !== "val") throw new Error("Expected a field name in filter");
    const field = f.v!;
    const type = fieldTypes[field];
    if (!type) throw new Error(`Unknown filter field: ${field}`);
    expect(":");
    return parseMatcher(field, type);
  }
  function parseMatcher(field: string, type: FieldType): Predicate {
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
        return (d) => {
          const v = Number(d[field]);
          return !Number.isNaN(v) && v >= lo && v <= hi;
        };
      }
      const vals = [first];
      while (peek() && peek().t === ",") { next(); vals.push(getVal()); }
      expect("]");
      if (type === "number") {
        const nums = vals.map((x) => Number(x));
        for (let k = 0; k < nums.length; k++) {
          if (Number.isNaN(nums[k])) {
            throw new Error(`Invalid number in filter for ${field}: ${vals[k]}`);
          }
        }
        return (d) => {
          const v = Number(d[field]);
          return !Number.isNaN(v) && nums.includes(v);
        };
      }
      return (d) => d[field] !== undefined && vals.includes(String(d[field]));
    }
    if (p && (p.t === ">" || p.t === ">=" || p.t === "<" || p.t === "<=")) {
      const op = next().t;
      if (type !== "number") throw new Error(`Comparator filter requires a numeric field: ${field}`);
      const num = Number(getVal());
      if (Number.isNaN(num)) throw new Error(`Invalid number in filter for ${field}`);
      return (d) => {
        const v = Number(d[field]);
        if (Number.isNaN(v)) return false;
        return op === ">" ? v > num : op === ">=" ? v >= num : op === "<" ? v < num : v <= num;
      };
    }
    const val = getVal();
    if (type === "number") {
      const n = Number(val);
      if (Number.isNaN(n)) throw new Error(`Invalid number in filter for ${field}: ${val}`);
      return (d) => {
        const v = Number(d[field]);
        return !Number.isNaN(v) && v === n;
      };
    }
    return (d) => d[field] !== undefined && String(d[field]) === val;
  }

  const pred = parseExpr();
  if (pos !== toks.length) throw new Error("Unexpected trailing tokens in filter");
  return pred;
}
