# Tests

This directory contains all tests for the proxy service.

## Test Organization

Tests are organized to mirror the source structure:

- **components/** - Unit tests for each component
- **integration/** - Integration tests for full request flows
- **properties/** - Property-based tests using fast-check
- **utils/** - Unit tests for utility functions

## Test Types

### Unit Tests
Test individual functions and components in isolation. Located alongside the code they test using `.test.ts` suffix when appropriate, or in this `tests/` directory.

### Property-Based Tests
Use fast-check to verify properties hold across many randomly generated inputs. These tests are particularly important for validating correctness requirements from the spec.

### Integration Tests
Test complete request flows through multiple components to ensure they work together correctly.

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Generate coverage report
npm run test:coverage
```
