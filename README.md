# North Carolina Contractors and Homeowners Protection Payment Plan

A web app where a contractor offers the plan on a job, the homeowner deposits the
full job price up front, and the contractor is paid step by step as each step
passes an independent inspection or a permit office inspection.

**The app never holds money itself.** Stripe, a licensed payments provider, takes
the homeowner's deposit, sends each payment to the contractor's own Stripe account,
and refunds the homeowner. The app only decides *when* money moves and keeps the
record of whose money it is.

## How a job works

1. **Contractor** signs up, sets up payouts with Stripe, and creates a job: the
   payment steps, who checks each step (independent inspector or permit office),
   and the estimated permit fees. They send the homeowner an invite link.
2. **Homeowner** opens the link, creates an account, accepts, and deposits:
   job price + permit fee fund + 1.25% service fee (bank, card or Cash App Pay via Stripe Checkout).
3. **Contractor** finishes a step and uploads photos (and the permit number for permit steps).
4. **Staff** assign an independent inspector, or record the permit office's result.
   Staff can never approve a payment on their own, and neither can the homeowner.
5. **Inspector** records pass or fail on site. A pass sends the step's amount, less
   the contractor's 1.25% fee, to the contractor right away. A fail sends notes back.
6. **Permits:** the contractor records each permit they pulled and is paid back from
   the homeowner's permit fund. If fees run over, the homeowner is asked to top up.
   Unused permit money is refunded to the homeowner when the job is done.
7. **Problems:** either side can report a problem on one step (only that step's money
   is frozen) or the whole job. Staff then pay the step, resume the job, or refund
   all secured money to the homeowner.

## Try it on your computer

You need [Node.js](https://nodejs.org) 22.13 or newer.

```bash
npm install
cp .env.example .env      # then fill in SESSION_SECRET
npm run seed              # sample logins, password: demo-password
npm start                 # open http://localhost:3000
```

Sample logins: `contractor@demo.test`, `homeowner@demo.test`, `staff@demo.test`,
`inspector@demo.test`.

Without a Stripe key the app runs in **practice mode**: payments are simulated and
a yellow bar says so on every page.

## Putting it online (Render)

1. Sign up at https://render.com with your GitHub account.
2. Click **New**, then **Blueprint**, and pick this repository. Render reads `render.yaml`.
3. Fill in `STAFF_EMAIL` and `STAFF_PASSWORD` (your own staff login). Leave the Stripe fields empty for now.
4. Click **Apply**. In a few minutes Render shows the app's web address.

It starts in practice mode with the sample logins above. Set `SEED_SAMPLE_DATA` to
`false` in Render's Environment page before real customers use it.

## Turning on Stripe test mode

1. Create a free Stripe account and turn on **Connect** in the Dashboard.
2. Put your test secret key (`sk_test_...`) in `.env` as `STRIPE_SECRET_KEY`.
3. Forward webhooks while testing locally:
   `stripe listen --forward-to localhost:3000/stripe/webhook`,
   and put the `whsec_...` it prints in `STRIPE_WEBHOOK_SECRET`.
   In production, add a webhook endpoint for `checkout.session.completed`,
   `checkout.session.async_payment_succeeded` and `account.updated`.
4. Restart. Pay with Stripe's test card `4242 4242 4242 4242`.

Which payment methods homeowners see (card, bank account, Cash App Pay) is set in
the Stripe Dashboard under Payment methods.

The money model is Stripe Connect "separate charges and transfers": the deposit is
charged on the platform account, and each passed step is a transfer to the
contractor's Express account, linked to the original charge.

## Before real money moves

- Have a North Carolina fintech attorney confirm the structure. Holding a customer's
  money and paying it out later is regulated as money transmission in NC.
- Confirm with Stripe that your business and how long funds are held (remodels can
  run for months) are allowed on their platform, or choose a partner built for
  long-held project funds.
- Add email delivery for invites and notifications (today the contractor copies the link).
- Run it on a host with HTTPS and back up the `data/` folder (database and photos).

## For developers

- `src/services.js`: the rules (who can do what, what money moves when)
- `src/payments.js`: Stripe adapter and the simulated adapter
- `src/app.js`: web routes; `views/`: pages; `src/db.js`: database tables
- `npm test` runs the full job flow end to end with simulated payments.
