const MAX_ITEMS_PER_LINE = 3;
const INDENT = '  ';
const LEADING_WHITESPACE = /^\s*/;

export const READABILITY_RULES = {
  semi: ['error', 'always'],
  'lines-between-class-members': [
    'error',
    {
      enforce: [
        {
          blankLine: 'always',
          prev: '*',
          next: 'method',
        },
        {
          blankLine: 'always',
          prev: 'method',
          next: '*',
        },
      ],
    },
  ],
  'readability/max-items-per-line': 'error',
};

export default {
  rules: {
    'max-items-per-line': {
      meta: {
        type: 'layout',
        docs: { description: 'Allow at most three properties, arguments or parameters per line' },
        fixable: 'whitespace',
        schema: [],
        messages: { crowded: 'Use at most three {{kind}} per line.' },
      },
      create(context) {
        const source = context.sourceCode;
        function check(
          node,
          items,
          closingValue,
          kind
        ) {
          const counts = new Map();
          const crowded = items.some((item) => {
            const line = item.loc.start.line;
            const count = (counts.get(line) ?? 0) + 1;
            counts.set(line, count);
            return count > MAX_ITEMS_PER_LINE;
          });
          if (!crowded) return;
          context.report({
            node,
            messageId: 'crowded',
            data: { kind },
            fix(fixer) {
              const opening = source.getTokenBefore(items[0]);
              const indentation =
                source.lines[opening.loc.start.line - 1].match(LEADING_WHITESPACE)[0];
              const fixes = [];
              // Change only the whitespace next to each item. Comments and expressions
              // remain in their original order, including comments between arguments.
              for (const item of items) {
                const previous = source.getTokenBefore(item, { includeComments: true });
                fixes.push(
                  fixer.replaceTextRange(
                    [previous.range[1], item.range[0]],
                    `\n${indentation}${INDENT}`,
                  ),
                );
                const oldIndent =
                  source.lines[item.loc.start.line - 1].match(LEADING_WHITESPACE)[0];
                const delta = indentation.length + INDENT.length - oldIndent.length;
                const adjusted = new Set();
                // When an argument moves onto its own line, move its code indentation
                // with it. Never edit whitespace inside a string or template literal.
                for (const token of source.getTokens(item, { includeComments: true })) {
                  const line = token.loc.start.line;
                  if (line === item.loc.start.line || adjusted.has(line)) continue;
                  adjusted.add(line);
                  const prefix = source.lines[line - 1].slice(0, token.loc.start.column);
                  if (prefix.trim() !== '' || delta === 0) continue;
                  fixes.push(
                    fixer.replaceTextRange(
                      [token.range[0] - prefix.length, token.range[0]],
                      ' '.repeat(Math.max(0, prefix.length + delta)),
                    ),
                  );
                }
              }
              const closing = source.getTokenAfter(items.at(-1), {
                filter: (token) => token.value === closingValue,
              });
              const previous = source.getTokenBefore(closing, { includeComments: true });
              fixes.push(
                fixer.replaceTextRange([previous.range[1], closing.range[0]], `\n${indentation}`),
              );
              return fixes;
            },
          });
        }
        const parameters = (node) => check(
          node,
          node.params,
          ')',
          'parameters'
        );
        return {
          ObjectExpression: (node) => check(
            node,
            node.properties,
            '}',
            'properties'
          ),
          ObjectPattern: (node) => check(
            node,
            node.properties,
            '}',
            'properties'
          ),
          CallExpression: (node) => check(
            node,
            node.arguments,
            ')',
            'arguments'
          ),
          NewExpression: (node) => check(
            node,
            node.arguments,
            ')',
            'arguments'
          ),
          TSTypeLiteral: (node) => check(
            node,
            node.members,
            '}',
            'properties'
          ),
          TSInterfaceBody: (node) => check(
            node,
            node.body,
            '}',
            'properties'
          ),
          FunctionDeclaration: parameters,
          FunctionExpression: parameters,
          ArrowFunctionExpression: parameters,
          TSDeclareFunction: parameters,
          TSEmptyBodyFunctionExpression: parameters,
          TSMethodSignature: parameters,
          TSCallSignatureDeclaration: parameters,
          TSConstructSignatureDeclaration: parameters,
          TSFunctionType: parameters,
          TSConstructorType: parameters,
        };
      },
    },
  },
};
