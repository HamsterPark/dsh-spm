/**
 * The visual harness's standing instructions (VISUAL-HARNESS §4.7), registered
 * as a system-prompt section by the plugin.
 *
 * Ported from the reference's minimal prompt (VISTA-SPM `prompts.py::SYSTEM_TEMPLATE`,
 * image arm with notes), which follows VISTA's own ARC prompt (MIT): an
 * objective, a revisable model, expect before / report after, and notes.
 * Nothing here teaches STM technique; the task comes from the user.
 *
 * Two intended differences (spec/deviations.md D-ACT-1, D-K14-3):
 * - "Before each `act`" reads "Before each action that changes the
 *   instrument": this repository has no single `act` tool; the actions are
 *   the skill tools that change the instrument, and those are the ones the
 *   one-act-one-observation gate holds back.
 * - The last line is not in the reference. Some dsh routes drop the oldest
 *   images of a long session and tell the model to ask the user to attach
 *   them again (docs/dsh/facts.md §9.3); for a frame the right move is to look
 *   at it again with `stm_inspect`.
 */
import { GUIDE_FILE, WORKING_FILE } from './notes.js'

/** Section name (unique in the prompt registry). */
export const VISUAL_HARNESS_PROMPT_NAME = 'mast-visual-harness'

/**
 * Section order, among dsh's allocated ones (`SECTION_ORDERS` of
 * dsh-system-prompt): right after the deployment persona prefix (0), before the
 * plan and team policies (500, 600) and the tool sections (1000 and up). An IC
 * agent preset, once there is one, can take these lines into its own persona
 * (`deployment:persona-prefix`) instead.
 */
export const VISUAL_HARNESS_PROMPT_ORDER = 150

export const VISUAL_HARNESS_PROMPT = [
  '# Instrument task',
  'You are operating a scanning tunnelling microscope through the tools of this session.',
  'Complete the task with as little instrument time and as few instrument actions as possible.',
  'Build and use a compact, revisable model of the instrument, the tip and the sample, and of their current state. ' +
    'Update it as new evidence changes what is supported.',
  'Before each action that changes the instrument, briefly state what you expect to see. ' +
    'Afterward, briefly state all visible changes, expected or not.',
  `Keep concise, durable, revisable understanding in \`${GUIDE_FILE}\`; use \`${WORKING_FILE}\` as a scratchpad when useful.`,
  'An earlier image that is no longer shown can be looked at again with `stm_inspect`.',
].join('\n\n')
