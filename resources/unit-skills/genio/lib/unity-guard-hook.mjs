#!/usr/bin/env node
import { guardMain } from './unity-guard.mjs'
process.exitCode = await guardMain()
