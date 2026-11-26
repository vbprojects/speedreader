/** Scalar TwineScript expressions used by declarative passage actions. */
export type Value = string | number | boolean;
export type Variables = Record<string, Value>;

const precedence = new Map<string, number>([
  ["or", 1], ["||", 1], ["and", 2], ["&&", 2],
  ...["is", "eq", "==", "===", "isnot", "neq", "!=", "!=="].map((op): [string, number] => [op, 3]),
  ...["<", ">", "<=", ">=", "lt", "gt", "lte", "gte"].map((op): [string, number] => [op, 4]),
  ["+", 5], ["-", 5], ["*", 6], ["/", 6], ["%", 6],
]);

function binary(op: string, left: Value, right: Value): Value {
  switch (op) {
    case "or": case "||": return left || right;
    case "and": case "&&": return left && right;
    case "is": case "eq": case "==": case "===": return left === right;
    case "isnot": case "neq": case "!=": case "!==": return left !== right;
    case "<": case "lt": return left < right;
    case ">": case "gt": return left > right;
    case "<=": case "lte": return left <= right;
    case ">=": case "gte": return left >= right;
    case "+": return typeof left === "string" || typeof right === "string" ? String(left) + right : Number(left) + Number(right);
    case "-": return Number(left) - Number(right);
    case "*": return Number(left) * Number(right);
    case "/": return Number(left) / Number(right);
    case "%": return Number(left) % Number(right);
    default: throw new Error("Unknown expression operator: " + op);
  }
}

export function value(source: string, variables: Variables): Value {
  const input = source.trim();
  const pattern = /\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\$\w+|\d+(?:\.\d+)?|\w+|===?|!==?|[<>]=?|&&|\|\||[!()+*/%-])/gy;
  const tokens: string[] = [];
  while (pattern.lastIndex < input.length) {
    const match = pattern.exec(input);
    if (!match) throw new Error("Unsupported SugarCube expression: " + input);
    tokens.push(match[1]);
  }

  let cursor = 0;
  function operand(): Value {
    const token = tokens[cursor++];
    if (token === "(") {
      const result = expression(1);
      if (tokens[cursor++] !== ")") throw new Error("Missing closing parenthesis: " + input);
      return result;
    }
    if (token === "!" || token === "not") return !operand();
    if (token === "-") return -Number(operand());
    if (token?.startsWith("$")) return variables[token] ?? "";
    if (token === "true" || token === "false") return token === "true";
    if (/^\d/.test(token)) return Number(token);
    if (/^['"]/.test(token)) return token.slice(1, -1).replace(/\\(['"\\])/g, "$1");
    throw new Error("Unsupported SugarCube expression: " + input);
  }
  function expression(min: number): Value {
    let left = operand();
    while ((precedence.get(tokens[cursor]) ?? 0) >= min) {
      const op = tokens[cursor++];
      left = binary(op, left, expression(precedence.get(op)! + 1));
    }
    return left;
  }
  const result = expression(1);
  if (cursor !== tokens.length) throw new Error("Unexpected expression token: " + tokens[cursor]);
  return result;
}
