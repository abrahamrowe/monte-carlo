# Example sheet layouts

Copy any of these into your sheet, paste `dist/MonteCarlo.gs` into
Extensions → Apps Script, then run **Monte Carlo → Run Simulation**.

## 1. Profit model (parameter mode)

| A (label)       | B (value)      | C (MonteCarlo) | D (p1)     | E (p2)    |
|-----------------|----------------|--------------|------------|-----------|
| Price per unit  | 100            | Normal       | 100        | 10        |
| Units sold      | 1000           | Normal       | 1000       | 300       |
| Fixed costs     | 50000          |              |            |           |
| Variable cost   | 0.4            | Uniform      | 0.3        | 0.5       |
| Revenue         | =B1*B2         |              |            |           |
| Variable total  | =B2*B1*B4      |              |            |           |
| Profit          | =B5-B6-B3      | Output       |            |           |

## 2. Profit model (quantile mode — "p10/p90 feels more natural")

| A               | B            | C (MonteCarlo) | D (p10)   | E (p90)   |
|-----------------|--------------|--------------|-----------|-----------|
| Price per unit  | 100          | Normal       | 80        | 120       |
| Units sold      | 1000         | LogNormal    | 500       | 2000      |
| Fixed costs     | 50000        |              |           |           |
| Variable cost   | 0.4          | Uniform      | 0.32      | 0.48      |
| Revenue         | =B1*B2       |              |           |           |
| Variable total  | =B2*B1*B4    |              |           |           |
| Profit          | =B5-B6-B3    | Output       |           |           |

## 3. Portfolio with correlated outputs

Two outputs from the same inputs — handy to see sensitivity attribution
across outputs.

| A (label)       | B (value)      | C (MonteCarlo) | D (p10)   | E (p90)   |
|-----------------|----------------|--------------|-----------|-----------|
| Stocks return   | 0.08           | Normal       | -0.05     | 0.21      |
| Bonds return    | 0.04           | Normal       | 0.01      | 0.07      |
| Stock alloc     | 0.6            |              |           |           |
| Bonds alloc     | 0.4            |              |           |           |
| Portfolio ret   | =B1*B3+B2*B4   | Output       |           |           |
| Shortfall vs 5% | =B5-0.05       | Output       |           |           |

## 4. Discrete outcomes

A weighted coin — "success" pays 100, "partial" pays 30, "fail" pays 0, with
weights 3 : 2 : 5.

| A       | B      | C (MonteCarlo) | D (x1) | E (w1) | F (x2) | G (w2) | H (x3) | I (w3) |
|---------|--------|--------------|--------|--------|--------|--------|--------|--------|
| Outcome | 0      | Discrete     | 100    | 3      | 30     | 2      | 0      | 5      |
| Runs    | 10     |              |        |        |        |        |        |        |
| Total   | =B1*B2 | Output       |        |        |        |        |        |        |

## 5. Branching logic with `IF`

| A          | B                              | C (MonteCarlo) | D    | E    |
|------------|--------------------------------|--------------|------|------|
| Demand     | 100                            | Normal       | 100  | 25   |
| Price      | =IF(B1 > 110, 90, 100)         |              |      |      |
| Revenue    | =B1*B2                         | Output       |      |      |

Branches are evaluated eagerly but errors in the non-taken branch never
surface — they're silently dropped.
