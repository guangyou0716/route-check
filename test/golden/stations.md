# Route check

| serials | records | route steps | required | finished | finished first pass | WIP | RTY |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 12 | 51 | 4 | 4 | 11 | 6 (54.5%) | 1 | 61.1% |

Order: replayed by timestamp.

## Yield per step

| step | units | first pass | FPY | passed (final) | fails | retests | records |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| SMT | 12 | 12 | 100.0% | 12 | 0 | 0 | 12 |
| ICT | 12 | 11 | 91.7% | 12 | 1 | 1 | 13 |
| FCT | 12 | 8 | 66.7% | 11 | 4 | 3 | 15 |
| PACK | 11 | 11 | 100.0% | 11 | 0 | 0 | 11 |

## Yield per station

Each unit's first record at a step counts for the station it ran on; retests = later records at the step.

| step | station | units | first pass | fpy | fails | retests | records |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| SMT | SMT-L1 | 12 | 12 | 100.0% | 0 | 0 | 12 |
| ICT | ICT-1 | 6 | 6 | 100.0% | 0 | 1 | 7 |
| ICT | ICT-2 | 6 | 5 | 83.3% | 1 | 0 | 6 |
| FCT | FCT-A | 6 | 6 | 100.0% | 0 | 3 | 9 |
| FCT | FCT-B | 6 | 2 | 33.3% | 4 | 0 | 6 |
| PACK | PACK-1 | 11 | 11 | 100.0% | 0 | 0 | 11 |

Retests = records after each unit's first record at the step. RTY = product of FPY over required steps.

## Findings: 1

| kind | count |
| --- | ---: |
| continued-after-fail | 1 |

### Continued after fail (a later step ran while the latest result here was fail): 1

- BRD-210 failed FCT (row 43) and ran PACK (row 49) without passing FCT again
