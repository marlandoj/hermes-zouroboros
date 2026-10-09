#!/usr/bin/env bun
// Thin entry point: the self-heal loop runs in integration/selfheal.ts over packages/selfheal.
import { run } from '../../../../integration/selfheal.ts';

run('introspect');
