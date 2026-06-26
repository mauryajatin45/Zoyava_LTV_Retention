import { useEffect, useState } from 'react';
import {
  Page, Layout, Card, DataTable, Badge, Banner,
  Text, Spinner, BlockStack, InlineStack, Box,
} from '@shopify/polaris';
// App Bridge v4 automatically intercepts native fetch, so we don't need utilities.

// Human-readable names — update when variant IDs are mapped to product titles
const VARIANT_NAMES = {
  48336835018993: 'Reward Chart',
  48336838623473: 'Sticker Pack',
  48212608712945: 'Free Bonus Bag',
  48336838721777: 'Cycle 2 — Item A',
  48336841441521: 'Cycle 2 — Item B',
  48336845046001: 'Cycle 3 — Item A',
  48336851009777: 'Cycle 4 — Item A',
  48336854155505: 'Cycle 4 — Item B',
  48336856056049: 'Cycle 5/6 — Item A',
  48336855728369: 'Cycle 6 — Item B',
};

export default function Index() {
  const [ladder, setLadder] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch('/api/ltv-config')
      .then((res) => res.json())
      .then((data) => {
        setLadder(data.ladder);
        setLoading(false);
      })
      .catch((err) => {
        console.error('[Frontend] Failed to fetch /api/ltv-config:', err);
        setError('Failed to load configuration. Check browser console for details.');
        setLoading(false);
      });
  }, []);

  const tableRows = ladder
    ? Object.entries(ladder).map(([cycle, variantIds]) => [
        <Text fontWeight="bold">Cycle {cycle}</Text>,
        <BlockStack gap="100">
          {variantIds.map((id) => (
            <InlineStack key={id} gap="200" align="start">
              <Badge tone="success">Variant {id}</Badge>
              <Text tone="subdued">{VARIANT_NAMES[id] || 'Unknown SKU'}</Text>
            </InlineStack>
          ))}
        </BlockStack>,
        <Badge tone="info">$0.00 Injected</Badge>,
        variantIds.length === 1
          ? <Badge>Single Gift</Badge>
          : <Badge tone="attention">{variantIds.length} Gifts</Badge>,
      ])
    : [];

  return (
    <Page
      title="LTV Retention Gifting Engine"
      subtitle="Automatically injects gift SKUs into customers' next Recharge charge based on subscription cycle."
    >
      <Layout>
        <Layout.Section>
          <Banner
            title="Recharge Webhook Endpoint"
            tone="info"
          >
            <Text as="p">
              Register this URL in your Recharge dashboard under
              Webhooks → Add Webhook → Event: <strong>charge/paid</strong>
            </Text>
            <Box paddingBlockStart="200">
              <Text as="code" fontWeight="bold">
                {window.location.origin}/webhooks/recharge/charge-paid
              </Text>
            </Box>
          </Banner>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="400">
              <Text variant="headingMd" as="h2">
                LTV Gifting Ladder — Active Configuration
              </Text>

              {loading && (
                <InlineStack align="center">
                  <Spinner size="large" />
                </InlineStack>
              )}

              {error && (
                <Banner tone="critical">{error}</Banner>
              )}

              {!loading && !error && ladder && (
                <DataTable
                  columnContentTypes={['text', 'text', 'text', 'text']}
                  headings={['Cycle', 'Gift Variants', 'Price', 'Count']}
                  rows={tableRows}
                />
              )}
            </BlockStack>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd" as="h2">How It Works</Text>
              <Text as="p">
                1. A customer's Recharge subscription charge is processed
                successfully.
              </Text>
              <Text as="p">
                2. Recharge fires a <strong>charge/paid</strong> webhook to this
                app's endpoint.
              </Text>
              <Text as="p">
                3. The app reads the <strong>orders_count</strong> from the
                charge payload to determine the subscription cycle.
              </Text>
              <Text as="p">
                4. The mapped variant IDs for the <strong>next cycle</strong> are injected as
                <strong> $0.00 onetimes</strong> into the customer's next
                upcoming Recharge delivery.
              </Text>
              <Text as="p">
                <em>Note: Cycle 1 gifts are handled natively on the frontend via Cart AJAX logic.</em>
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
