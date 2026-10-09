// js-yaml-compatible load/dump over the distribution's `yaml` dependency.
// Unlike js-yaml, unquoted dates stay strings (YAML 1.2 core schema); callers already
// normalise both shapes.
import { parse, stringify } from "yaml";

export function load(text: string): unknown {
  return parse(text);
}
export function dump(value: unknown, options: { lineWidth?: number; noRefs?: boolean } = {}): string {
  return stringify(value, { lineWidth: options.lineWidth ?? 80, aliasDuplicateObjects: options.noRefs ? false : true });
}
