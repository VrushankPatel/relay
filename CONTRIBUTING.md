# Contributing to Relay

We love contributions! Here's how to get started.

## Getting Started

1. Fork the repository
2. Clone your fork: `git clone https://github.com/your-username/relay.git`
3. Install dependencies: `npm install`
4. Create a branch: `git checkout -b feature/my-feature`

## Development

```bash
npm run build        # Build ESM + DTS
npm run dev          # Build in watch mode
npm test             # Run all tests
npm run test:watch   # Tests in watch mode
npm run typecheck    # TypeScript type checking
npm run lint         # ESLint
```

## Code Style

- **No comments in source files** — code should be self-documenting
- **TypeScript strict mode** — avoid `any`, prefer explicit types
- **Native Node.js APIs** — no Fastify, no Express, no undici
- **Imports end with `.js`** — all relative imports use explicit `.js` extensions
- **Follow existing patterns** — mimic the style of adjacent code

## Testing

- All new features need tests
- Property-based tests (via `fast-check`) strongly encouraged for data transformations
- Run `npm test` before committing — all tests must pass

## Pull Request Process

1. Run `npm run build && npm test && npm run typecheck && npm run lint`
2. Write a clear PR title and description
3. Reference related issues
4. Keep PRs focused — one feature per PR

## Project Structure

```
src/
  components/     # Core components (CacheManager, RequestForwarder, etc.)
  types/          # TypeScript type definitions
  utils/          # Utilities (logger, etc.)
  index.ts        # Entry point
tests/
  components/     # Component tests
  utils/          # Utility tests
```

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
