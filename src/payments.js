// Money movement. The app never holds money itself: Stripe (a licensed payments
// provider) collects the homeowner's deposit into the platform's Stripe balance,
// sends draws to the contractor's own Stripe account, and refunds the homeowner.
//
// Two adapters share one interface:
//   stripePayments  - real Stripe Connect calls (test mode with sk_test_ keys)
//   simulatedPayments - no Stripe account needed; for demos and automated tests
const crypto = require('node:crypto');

function stripePayments({ secretKey, webhookSecret }) {
  const Stripe = require('stripe');
  const stripe = new Stripe(secretKey);

  return {
    mode: secretKey.startsWith('sk_live_') ? 'live' : 'test',

    // Creates (once) an Express connected account for the contractor and
    // returns a Stripe-hosted onboarding link where they add their bank.
    async onboardingLink(user, { returnUrl, refreshUrl }) {
      let accountId = user.stripe_account_id;
      if (!accountId) {
        const account = await stripe.accounts.create({
          type: 'express',
          country: 'US',
          email: user.email,
          business_type: 'company',
          company: user.company ? { name: user.company } : undefined,
          capabilities: { transfers: { requested: true } },
          metadata: { app_user_id: String(user.id) },
        });
        accountId = account.id;
      }
      const link = await stripe.accountLinks.create({
        account: accountId,
        type: 'account_onboarding',
        return_url: returnUrl,
        refresh_url: refreshUrl,
      });
      return { accountId, url: link.url };
    },

    async payoutsReady(accountId) {
      const account = await stripe.accounts.retrieve(accountId);
      return Boolean(account.payouts_enabled && account.capabilities?.transfers === 'active');
    },

    // Stripe Checkout page for the homeowner's payment.
    async startCheckout({ payment, job, lineItems, successUrl, cancelUrl, email }) {
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer_email: email,
        // Which payment methods show (card, bank, Cash App Pay) is set in the Stripe Dashboard.
        line_items: lineItems.map((li) => ({
          quantity: 1,
          price_data: { currency: 'usd', unit_amount: li.cents, product_data: { name: li.name } },
        })),
        payment_intent_data: {
          transfer_group: `job_${job.id}`,
          metadata: { job_id: String(job.id), payment_id: String(payment.id) },
        },
        metadata: { job_id: String(job.id), payment_id: String(payment.id) },
        success_url: successUrl + (successUrl.includes('?') ? '&' : '?') + 'session_id={CHECKOUT_SESSION_ID}',
        cancel_url: cancelUrl,
      });
      return { checkoutId: session.id, url: session.url };
    },

    // Returns { paymentIntentId, chargeId } once the money is actually in, else null.
    // Bank (ACH) payments stay "processing" for a few days before they count.
    async checkoutResult(checkoutId) {
      const session = await stripe.checkout.sessions.retrieve(checkoutId, {
        expand: ['payment_intent'],
      });
      if (session.payment_status !== 'paid') return null;
      const pi = session.payment_intent;
      return { paymentIntentId: pi.id, chargeId: pi.latest_charge };
    },

    async transfer({ accountId, cents, chargeId, jobId, idempotencyKey, description }) {
      const t = await stripe.transfers.create(
        {
          amount: cents,
          currency: 'usd',
          destination: accountId,
          source_transaction: chargeId || undefined,
          transfer_group: `job_${jobId}`,
          description,
        },
        { idempotencyKey }
      );
      return t.id;
    },

    async refund({ paymentIntentId, cents, idempotencyKey }) {
      const r = await stripe.refunds.create(
        { payment_intent: paymentIntentId, amount: cents },
        { idempotencyKey }
      );
      return r.id;
    },

    parseWebhook(rawBody, signature) {
      if (!webhookSecret) throw new Error('STRIPE_WEBHOOK_SECRET is not set');
      return stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    },
  };
}

function simulatedPayments() {
  const id = (p) => `${p}_sim_${crypto.randomBytes(6).toString('hex')}`;
  const paidCheckouts = new Map();
  return {
    mode: 'simulated',
    async onboardingLink(user, { returnUrl }) {
      return { accountId: user.stripe_account_id || id('acct'), url: returnUrl };
    },
    async payoutsReady() {
      return true;
    },
    async startCheckout({ payment }) {
      const checkoutId = id('cs');
      return { checkoutId, url: `/simulate/checkout/${payment.id}?session_id=${checkoutId}` };
    },
    markCheckoutPaid(checkoutId) {
      paidCheckouts.set(checkoutId, { paymentIntentId: id('pi'), chargeId: id('ch') });
    },
    async checkoutResult(checkoutId) {
      return paidCheckouts.get(checkoutId) || null;
    },
    async transfer() {
      return id('tr');
    },
    async refund() {
      return id('re');
    },
    parseWebhook() {
      throw new Error('Webhooks are not used in simulated mode');
    },
  };
}

function paymentsFromEnv(env = process.env) {
  if (env.STRIPE_SECRET_KEY) {
    return stripePayments({
      secretKey: env.STRIPE_SECRET_KEY,
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    });
  }
  return simulatedPayments();
}

module.exports = { stripePayments, simulatedPayments, paymentsFromEnv };
