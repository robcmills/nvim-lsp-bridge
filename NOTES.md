
```
⏺ Bash(npx tsc --noEmit e2e/cypress/e2e/sheets/mocks.ts 2>&1 | head -60)
  ⎿  Using Node v24.13.0
     error TS2688: Cannot find type definition file for 'minimatch'.
       The file is in the program because:
         Entry point for implicit type library 'minimatch'
  ⎿  (timeout 1m)

⏺ Bash(npx tsc --noEmit --skipLibCheck 2>&1 | grep -A 10 "mocks.ts" | head -40)
  ⎿  Using Node v24.13.0
     e2e/cypress/e2e/sheets/mocks.ts(20,1): error TS6133: 'DeepPartial' is declared but its value is never read.
     e2e/cypress/e2e/sheets/mocks.ts(154,5): error TS2769: No overload matches this call.
     … +16 lines (ctrl+o to expand)
  ⎿  (timeout 2m)
```
