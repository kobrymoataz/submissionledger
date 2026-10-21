import { InputError } from '../core/errors.js';

type ValueFlag = 'db' | 'file' | 'data' | 'source' | 'key' | 'limit' | 'output';
type BooleanFlag = 'json' | 'help' | 'version';
type Flag = ValueFlag | BooleanFlag;

const VALUE_FLAGS = new Set<string>(['db', 'file', 'data', 'source', 'key', 'limit', 'output']);
const BOOLEAN_FLAGS = new Set<string>(['json', 'help', 'version']);

export interface Arguments {
  command: string;
  positionals: string[];
  options: Map<Flag, string | true>;
}

export function parseArguments(argv: string[]): Arguments {
  const positionals: string[] = [];
  const options = new Map<Flag, string | true>();
  for (let i = 0; i < argv.length; i += 1) {
    const argument = argv[i];
    if (argument === undefined) continue;
    if (!argument.startsWith('--')) {
      if (argument.startsWith('-')) throw new InputError(`Unexpected argument: ${argument}`);
      positionals.push(argument);
      continue;
    }
    const equals = argument.indexOf('=');
    const flagName = argument.slice(2, equals === -1 ? undefined : equals);
    if (!VALUE_FLAGS.has(flagName) && !BOOLEAN_FLAGS.has(flagName)) {
      throw new InputError(`Unknown option: --${flagName}`);
    }
    const flag = flagName as Flag;
    if (options.has(flag)) throw new InputError(`Option --${flagName} was provided more than once.`);
    if (BOOLEAN_FLAGS.has(flagName)) {
      if (equals !== -1) throw new InputError(`Option --${flagName} does not take a value.`);
      options.set(flag, true);
      continue;
    }
    const next = equals === -1 ? argv[++i] : argument.slice(equals + 1);
    if (next === undefined || next === '' || (equals === -1 && next.startsWith('--'))) {
      throw new InputError(`Option --${flagName} requires a value.`);
    }
    options.set(flag, next);
  }
  const [command = 'help', ...rest] = positionals;
  return { command, positionals: rest, options };
}

export function getString(args: Arguments, flag: ValueFlag): string | undefined {
  return args.options.get(flag) as string | undefined;
}

export function hasFlag(args: Arguments, flag: BooleanFlag): boolean {
  return args.options.get(flag) === true;
}

export function requireOption(args: Arguments, flag: ValueFlag): string {
  const value = getString(args, flag);
  if (value === undefined) throw new InputError(`Missing required option --${flag}.`);
  return value;
}

export function checkUsage(
  args: Arguments,
  allowed: ReadonlyArray<Flag>,
  minPositionals: number,
  maxPositionals = minPositionals,
): void {
  if (args.positionals.length < minPositionals || args.positionals.length > maxPositionals) {
    throw new InputError(`Invalid arguments for '${args.command}'. Run 'submissionledger help'.`);
  }
  for (const option of args.options.keys()) {
    if (option !== 'db' && option !== 'json' && !allowed.includes(option)) {
      throw new InputError(`Option --${option} is not valid for '${args.command}'.`);
    }
  }
}
