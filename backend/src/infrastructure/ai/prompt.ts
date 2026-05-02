import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { GenerateTestInput } from '@domain/ports/AICliPort';

/**
 * Build the test-generation prompt that we hand to any AI CLI adapter.
 *
 * The prompt is intentionally framework-agnostic: it tells the CLI _what_
 * to write (which file, append vs sibling, target framework) and _why_
 * (which lines are uncovered) without prescribing _how_ to assert.
 *
 * Style example: when we have one, we pass an existing test from the same
 * repo. This is the cheapest way to match assertion library and structure
 * without per-project configuration.
 */
export async function buildTestGenerationPrompt(input: GenerateTestInput): Promise<string> {
  const [sourceContent, existingTestContent] = await Promise.all([
    safeRead(join(input.workdir, input.sourceFilePath)),
    input.existingTestFilePath
      ? safeRead(join(input.workdir, input.existingTestFilePath))
      : Promise.resolve(null),
  ]);
  const styleExample = input.styleExample ?? '';

  const modeBlock =
    input.targetMode === 'append' && input.existingTestFilePath
      ? appendModeBlock(input.existingTestFilePath)
      : siblingModeBlock(input.targetTestFilePath);

  const retry = input.retryFeedback
    ? `\n\n# Previous attempt failed validation. Feedback:\n${input.retryFeedback}\n`
    : '';

  return [
    `# Improve test coverage`,
    ``,
    `Project test framework: ${input.framework}`,
    `Source file: \`${input.sourceFilePath}\``,
    `Currently uncovered lines (1-based): ${
      input.uncoveredLines.length ? input.uncoveredLines.join(', ') : '(unknown — improve overall coverage)'
    }`,
    ``,
    modeBlock,
    ``,
    `## Hard rules`,
    `- Do NOT modify the source file under test.`,
    `- Do NOT delete or alter any existing test cases (descriptions, assertions).`,
    `- Imports may be added; do not change existing imports.`,
    `- Tests must pass when the project's existing test command is run.`,
    `- Each new test must exercise at least one currently-uncovered line.`,
    ``,
    `## Source file`,
    '```ts',
    sourceContent,
    '```',
    ``,
    existingTestContent !== null
      ? ['## Existing test file', '```ts', existingTestContent, '```'].join('\n')
      : '## Existing test file\n(none)',
    ``,
    styleExample
      ? ['## Style example from another test in this project', '```ts', styleExample, '```'].join(
          '\n',
        )
      : '',
    retry,
    ``,
    `Write the file now using your tools.`,
  ].join('\n');
}

function appendModeBlock(existingTestPath: string): string {
  return [
    `## Mode: APPEND to existing test file`,
    ``,
    `Append new \`it\`/\`test\` cases inside an appropriate \`describe\` block in \`${existingTestPath}\`.`,
  ].join('\n');
}

function siblingModeBlock(siblingPath: string): string {
  return [
    `## Mode: CREATE new sibling test file`,
    ``,
    `Create a new test file at \`${siblingPath}\` with a complete suite covering the source file.`,
  ].join('\n');
}

async function safeRead(absolutePath: string): Promise<string> {
  try {
    await access(absolutePath);
    return await readFile(absolutePath, 'utf8');
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return '(file not found)';
    return `(read error: ${err.message})`;
  }
}
