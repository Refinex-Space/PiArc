// `NotebookEdit` (T42, architecture section 6.1.4): one cell of a Jupyter notebook inserted,
// replaced or deleted, on the notebook's own text (`notebook-text.ts`, the same algorithm as
// Core's `piarc_fs::notebook`, which recomputes the result to show the approval card's diff and
// to check the write). The file goes through Core like Edit's: the read asks Core whether this
// session read the notebook and it is unchanged since (`requireFresh`), the write is atomic, kept
// in the checkpoint and returns the diff (`details.fileDiff`, a `fileChange` item).
import { defineTool, type ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import type { FileChangeDetails } from './edit.js';
import { asFileError, type Origin } from './core-io.js';
import { editNotebook, NotebookError, type EditMode } from './notebook-text.js';
import { mutationKey, resolveToolPath } from './paths.js';
import { presentationOf, type ToolSetup } from './presentation.js';
import { serialized } from './stand-in.js';

/** Claude Code's parameters (descriptions PiArc's own). */
const notebookSchema = Type.Object({
  notebook_path: Type.String({ description: 'The notebook (.ipynb) to change.' }),
  cell_id: Type.Optional(
    Type.String({
      description:
        "The cell's id, or cell-N for the N-th cell counting from 0 in a notebook without ids. " +
        'Insert puts the new cell after it (first without it).',
    }),
  ),
  new_source: Type.String({ description: "The cell's complete new source." }),
  cell_type: Type.Optional(
    Type.String({
      enum: ['code', 'markdown'],
      description: 'The cell type: required to insert, changes the type when replacing.',
    }),
  ),
  edit_mode: Type.Optional(
    Type.String({
      enum: ['replace', 'insert', 'delete'],
      description: 'replace (the default), insert or delete.',
    }),
  ),
});

function mode(value: string | undefined): EditMode {
  return value === 'insert' || value === 'delete' ? value : 'replace';
}

export function createNotebookEditTool({ io, presentation }: ToolSetup): ToolDefinition {
  return defineTool<typeof notebookSchema, FileChangeDetails | undefined>({
    ...presentationOf(presentation),
    parameters: notebookSchema,
    async execute(toolCallId, params, signal, _onUpdate, ctx) {
      const origin: Origin = { tool: 'NotebookEdit', toolCallId };
      const target = resolveToolPath(params.notebook_path, ctx.cwd);
      return serialized(mutationKey(target), async () => {
        let text: string;
        try {
          text = (await io.readText(target, origin, signal, true)).toString('utf8');
        } catch (error) {
          throw asFileError(error, 'read', params.notebook_path);
        }
        const editMode = mode(params.edit_mode);
        let next: string;
        try {
          next = editNotebook(text, {
            mode: editMode,
            cellId: params.cell_id,
            newSource: params.new_source,
            cellType:
              params.cell_type === 'code' || params.cell_type === 'markdown'
                ? params.cell_type
                : undefined,
            seed: toolCallId,
          });
        } catch (error) {
          if (error instanceof NotebookError) throw new Error(error.message, { cause: error });
          throw error;
        }
        let fileDiff;
        try {
          fileDiff = await io.write(target, next, origin);
        } catch (error) {
          throw asFileError(error, 'open', params.notebook_path);
        }
        const done =
          editMode === 'insert'
            ? `Inserted a ${params.cell_type ?? 'code'} cell into ${params.notebook_path}.`
            : editMode === 'delete'
              ? `Deleted cell ${params.cell_id ?? ''} of ${params.notebook_path}.`
              : `Replaced cell ${params.cell_id ?? ''} of ${params.notebook_path}.`;
        return {
          content: [{ type: 'text', text: done }],
          details: fileDiff === undefined ? undefined : { fileDiff },
        };
      });
    },
  });
}
