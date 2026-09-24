#!/bin/zsh
# tools/calibration/run-crossfit.sh — the calibration fit as shipped: cross-fit A/B with their verification, the identity
# baseline, and the final all-player fit (then `fit.ts --smooth --write --out data/calibration/fit`). Resumable:
# fit.ts and verify.ts skip finished cells. Needs the rating models from `rating-eval.ts --train` (see README).
set -e
cd "$(dirname "$0")/../.."
D=data/calibration
fitdir() { # split model out
  bun tools/calibration/fit.ts --split $1 --model $2 --out $3 --workers 4 --chains 4 --offsets -1000:1000:100 --only bullet:600,bullet:800,bullet:1000,bullet:1200,bullet:1400,bullet:1600,bullet:1800,bullet:2000,bullet:2200,bullet:2400,bullet:2600,bullet:2800,bullet:3000
  bun tools/calibration/fit.ts --split $1 --model $2 --out $3 --workers 4 --chains 4 --only blitz:600,blitz:800,blitz:1000,blitz:1200,blitz:1400,blitz:1600,blitz:1800,blitz:2000,blitz:2200,blitz:2400,blitz:2600,blitz:2800,blitz:3000,rapid:600,rapid:800,rapid:1000,rapid:1200,rapid:1400,rapid:1600,rapid:1800,rapid:2000,rapid:2200,rapid:2400,rapid:2600,rapid:2800,rapid:3000
  bun tools/calibration/fit.ts --smooth --out $3
}
echo "== fit A $(date)"; fitdir fit $D/rating-model-fit.json $D/fit-A
echo "== verify A $(date)"; bun tools/calibration/verify.ts --table $D/fit-A/table-smooth12.json --label crossA --split holdout --model $D/rating-model-fit.json --chains 8 --workers 4
echo "== fit B $(date)"; fitdir holdout $D/rating-model-holdout.json $D/fit-B
echo "== verify B $(date)"; bun tools/calibration/verify.ts --table $D/fit-B/table-smooth12.json --label crossB --split fit --model $D/rating-model-holdout.json --chains 8 --workers 4
bun tools/calibration/crossfit.ts --a crossA --b crossB
echo "== identity baselines $(date)"
bun tools/calibration/verify.ts --table identity --label crossA0 --split holdout --model $D/rating-model-fit.json --chains 8 --workers 4
bun tools/calibration/verify.ts --table identity --label crossB0 --split fit --model $D/rating-model-holdout.json --chains 8 --workers 4
bun tools/calibration/crossfit.ts --a crossA0 --b crossB0
echo "== final fit $(date)"; fitdir all $D/rating-model.json $D/fit
echo "CROSSFIT-DONE $(date)"
