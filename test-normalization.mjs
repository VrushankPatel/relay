/**
 * Standalone test script to verify normalization logic
 * without requiring npm dependencies
 */

import crypto from 'crypto';

/**
 * Normalize whitespace in a string.
 */
function normalizeWhitespace(content) {
  // Step 1: Normalize line endings to LF
  let normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  
  // Step 2: Convert tabs to 4-space equivalent
  normalized = normalized.replace(/\t/g, '    ');
  
  // Step 3: Process line by line to preserve structure
  const lines = normalized.split('\n');
  const normalizedLines = lines.map((line) => {
    // Remove trailing whitespace
    line = line.replace(/\s+$/g, '');
    
    // Separate leading whitespace (indentation) from content
    const leadingMatch = line.match(/^(\s*)(.*)/);
    if (!leadingMatch) return line;
    
    const [, leading, content] = leadingMatch;
    
    // Preserve indentation but collapse multiple spaces in content
    const normalizedContent = content.replace(/\s+/g, ' ');
    
    return leading + normalizedContent;
  });
  
  // Step 4: Join lines back together
  return normalizedLines.join('\n');
}

function generateContextHash(context) {
  const components = [
    context.fileType,
    context.language,
    context.precedingContent,
    context.followingContent,
  ];
  
  const concatenated = components.join('||');
  const hash = crypto.createHash('sha256');
  hash.update(concatenated, 'utf8');
  return hash.digest('hex');
}

// Test cases
console.log('Testing normalization...\n');

// Test 1: Line endings normalization
const test1a = 'line1\r\nline2\rline3\n';
const test1b = 'line1\nline2\nline3\n';
const result1a = normalizeWhitespace(test1a);
const result1b = normalizeWhitespace(test1b);
console.log('Test 1: Line endings normalization');
console.log('  Input A:', JSON.stringify(test1a));
console.log('  Input B:', JSON.stringify(test1b));
console.log('  Result A:', JSON.stringify(result1a));
console.log('  Result B:', JSON.stringify(result1b));
console.log('  Match:', result1a === result1b ? '✓' : '✗');
console.log();

// Test 2: Tab to spaces
const test2 = '\tindented\n\t\tdouble';
const result2 = normalizeWhitespace(test2);
console.log('Test 2: Tab to spaces');
console.log('  Input:', JSON.stringify(test2));
console.log('  Result:', JSON.stringify(result2));
console.log('  Expected:', JSON.stringify('    indented\n        double'));
console.log('  Match:', result2 === '    indented\n        double' ? '✓' : '✗');
console.log();

// Test 3: Collapse multiple spaces
const test3 = 'const  x   =    10;';
const result3 = normalizeWhitespace(test3);
console.log('Test 3: Collapse multiple spaces');
console.log('  Input:', JSON.stringify(test3));
console.log('  Result:', JSON.stringify(result3));
console.log('  Expected:', JSON.stringify('const x = 10;'));
console.log('  Match:', result3 === 'const x = 10;' ? '✓' : '✗');
console.log();

// Test 4: Preserve indentation
const test4 = '    def  hello():\n        return  "world"';
const result4 = normalizeWhitespace(test4);
console.log('Test 4: Preserve indentation');
console.log('  Input:', JSON.stringify(test4));
console.log('  Result:', JSON.stringify(result4));
console.log('  Expected:', JSON.stringify('    def hello():\n        return "world"'));
console.log('  Match:', result4 === '    def hello():\n        return "world"' ? '✓' : '✗');
console.log();

// Test 5: Remove trailing whitespace
const test5 = '  leading\ntrailing  \n  both  ';
const result5 = normalizeWhitespace(test5);
console.log('Test 5: Remove trailing whitespace');
console.log('  Input:', JSON.stringify(test5));
console.log('  Result:', JSON.stringify(result5));
console.log('  Expected:', JSON.stringify('  leading\ntrailing\n  both'));
console.log('  Match:', result5 === '  leading\ntrailing\n  both' ? '✓' : '✗');
console.log();

// Test 6: Whitespace equivalence for hashing
const context1 = {
  fileType: '.ts',
  language: 'typescript',
  precedingContent: normalizeWhitespace('const x = 10;'),
  followingContent: normalizeWhitespace('const y = 20;'),
};

const context2 = {
  fileType: '.ts',
  language: 'typescript',
  precedingContent: normalizeWhitespace('const  x  =  10;'),
  followingContent: normalizeWhitespace('const   y   =   20;'),
};

const hash1 = generateContextHash(context1);
const hash2 = generateContextHash(context2);

console.log('Test 6: Whitespace equivalence for hashing');
console.log('  Context 1 (normalized):', context1);
console.log('  Context 2 (normalized):', context2);
console.log('  Hash 1:', hash1);
console.log('  Hash 2:', hash2);
console.log('  Hashes match:', hash1 === hash2 ? '✓' : '✗');
console.log();

// Test 7: Different content produces different hash
const context3 = {
  fileType: '.ts',
  language: 'typescript',
  precedingContent: normalizeWhitespace('const x = 11;'), // Different value
  followingContent: normalizeWhitespace('const y = 20;'),
};

const hash3 = generateContextHash(context3);

console.log('Test 7: Different content produces different hash');
console.log('  Context 1 hash:', hash1);
console.log('  Context 3 hash:', hash3);
console.log('  Hashes differ:', hash1 !== hash3 ? '✓' : '✗');
console.log();

// Summary
const allTests = [
  result1a === result1b,
  result2 === '    indented\n        double',
  result3 === 'const x = 10;',
  result4 === '    def hello():\n        return "world"',
  result5 === '  leading\ntrailing\n  both',
  hash1 === hash2,
  hash1 !== hash3,
];

const passedTests = allTests.filter(t => t).length;
console.log(`\n${'='.repeat(50)}`);
console.log(`Summary: ${passedTests}/${allTests.length} tests passed`);
console.log(`${'='.repeat(50)}`);

if (passedTests === allTests.length) {
  console.log('✓ All tests passed!');
  process.exit(0);
} else {
  console.log('✗ Some tests failed');
  process.exit(1);
}
