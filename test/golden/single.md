# Route check

| serials | records | route steps | required | finished | finished first pass | WIP | RTY |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 10 | 80 | 8 | 7 | 9 | 4 (44.4%) | 1 | 59.3% |

Order: replayed by timestamp. Rework records: 5. Records at steps not on the route: 1.

## Yield per step

| step | units | first pass | FPY | passed (final) | fails | retests | records |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| SMT | 10 | 10 | 100.0% | 10 | 0 | 0 | 10 |
| AOI | 9 | 9 | 100.0% | 9 | 0 | 0 | 9 |
| ICT | 9 | 8 | 88.9% | 9 | 1 | 1 | 10 |
| FLASH | 9 | 9 | 100.0% | 9 | 0 | 1 | 10 |
| CALIB | 9 | 9 | 100.0% | 9 | 0 | 2 | 11 |
| BURNIN (optional) | 1 | 1 | 100.0% | 1 | 0 | 0 | 1 |
| FCT | 9 | 6 | 66.7% | 7 | 6 | 5 | 14 |
| PACK | 9 | 9 | 100.0% | 9 | 0 | 0 | 9 |

Retests = records after each unit's first record at the step. RTY = product of FPY over required steps.

## Findings: 10

| kind | count |
| --- | ---: |
| skipped-step | 1 |
| out-of-order | 1 |
| continued-after-fail | 1 |
| failed-after-later-step | 1 |
| too-many-fails | 1 |
| incomplete | 4 |
| unknown-step | 1 |

### Skipped steps (a later step ran, this required step never passed): 1

- MTR-0003 ran ICT (row 10) but never passed AOI

### Out of order (a later step ran before this step was passed): 1

- MTR-0005 ran CALIB (row 33) before passing FLASH (passed later, row 38)

### Continued after fail (a later step ran while the latest result here was fail): 1

- MTR-0004 failed FCT (row 37) and ran PACK (row 43) without passing FCT again

### Failed after a later step (re-run failed after the unit had passed a later step): 1

- MTR-0007 passed PACK (row 60) but its latest result at FCT is fail (row 64)

### Too many fails at one step (--max-fails): 1

- MTR-0010 failed FCT 3 times (limit 2)

### Incomplete units (--complete): 4

- MTR-0003 has not passed AOI
- MTR-0004 has not passed FCT
- MTR-0006 has not passed ICT, FLASH, CALIB, FCT, PACK
- MTR-0007 has not passed FCT

### Steps not on the route: 1

- step "XRAY" is not on the route (1 row, 1 serial, first row 48); add it to the route or to --rework-steps
