import { useEffect, useState, useCallback } from 'react';
import {
  Page, Layout, Card, DataTable, Badge, Banner,
  Text, Spinner, BlockStack, InlineStack, Box, Thumbnail, Tabs
} from '@shopify/polaris';

export default function Index() {
  const [selectedTab, setSelectedTab] = useState(0);
  const [ladderOld, setLadderOld] = useState(null);
  const [ladderV3, setLadderV3] = useState(null);
  const [ladderV4, setLadderV4] = useState(null);
  const [variantDetails, setVariantDetails] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    console.log("[LTV Frontend] Index page mounted. Fetching /api/ltv-config...");
    fetch('/api/ltv-config')
      .then((res) => {
        console.log("[LTV Frontend] Fetch response status:", res.status);
        return res.json();
      })
      .then((data) => {
        console.log("[LTV Frontend] /api/ltv-config data received:", data);
        setLadderOld(data.ladderOld || data.ladder);
        setLadderV3(data.ladderV3 || null);
        setLadderV4(data.ladderV4 || null);
        setVariantDetails(data.variantDetails || {});
        setLoading(false);
      })
      .catch((err) => {
        console.error('[Frontend] Failed to fetch /api/ltv-config:', err);
        setError('Failed to load configuration. Check browser console for details.');
        setLoading(false);
      });
  }, []);

  const handleTabChange = useCallback((selectedTabIndex) => setSelectedTab(selectedTabIndex), []);

  const renderTableRows = (ladderObj, isV4 = false) => {
    if (!ladderObj) return [];
    return Object.entries(ladderObj).map(([cycle, variantIds]) => [
      <Text fontWeight="bold">Cycle {cycle}</Text>,
      <BlockStack gap="100">
        {variantIds.map((id) => {
          const details = variantDetails[id];
          const title = details?.productTitle || 'Unknown SKU';
          const variantText = details?.variantTitle;
          const image = details?.imageUrl;

          return (
            <InlineStack key={id} gap="200" align="start" blockAlign="center">
              {image ? (
                <Thumbnail source={image} alt={title} size="small" />
              ) : (
                <Box padding="200" background="bg-surface-secondary" borderRadius="100">
                  <Text as="span" tone="subdued">No img</Text>
                </Box>
              )}
              <BlockStack>
                <Text fontWeight="bold">{title}</Text>
                {variantText && <Text tone="subdued">{variantText}</Text>}
                <Badge tone="success">Variant {id}</Badge>
              </BlockStack>
            </InlineStack>
          );
        })}
      </BlockStack>,
      <Badge tone="info">$0.00 Injected</Badge>,
      isV4 ? (
        <Badge tone="attention">Scaled by Kid Count (N)</Badge>
      ) : (
        variantIds.length === 1 ? <Badge>1 Gift</Badge> : <Badge tone="attention">{variantIds.length} Gifts</Badge>
      ),
    ]);
  };

  const tabs = [
    {
      id: 'v4',
      content: 'Offer V4 (Hiya Per-Kid)',
      panelID: 'panel-v4',
    },
    {
      id: 'v3',
      content: 'Offer V3 (60-Day Starter Kit)',
      panelID: 'panel-v3',
    },
    {
      id: 'legacy',
      content: 'Legacy Funnel',
      panelID: 'panel-legacy',
    },
  ];

  return (
    <Page
      title="Zoyava LTV Gifting & Retention Engine"
      subtitle="Multi-funnel automated retention gift injection and billing cadence controller for Recharge."
    >
      <Layout>
        <Layout.Section>
          <Banner title="Recharge Webhook Routing & Setup" tone="info">
            <Text as="p">
              Register your primary webhook in Recharge Admin under <strong>Webhooks → Add Webhook → Event: charge/paid</strong> pointing to:
            </Text>
            <Box paddingBlockStart="200">
              <Text as="code" fontWeight="bold">
                {window.location.origin}/webhooks/recharge/charge-paid
              </Text>
            </Box>
            <Box paddingBlockStart="200">
              <Text as="p" tone="subdued">
                <em>Our smart router automatically identifies the Product ID in the paid order and routes it to the V3, V4, or Legacy automation engine!</em>
              </Text>
            </Box>
          </Banner>
        </Layout.Section>

        <Layout.Section>
          <Card padding="0">
            <Tabs tabs={tabs} selected={selectedTab} onSelect={handleTabChange}>
              <Box padding="400">
                {loading && (
                  <InlineStack align="center" padding="400">
                    <Spinner size="large" />
                  </InlineStack>
                )}

                {error && <Banner tone="critical">{error}</Banner>}

                {!loading && !error && selectedTab === 0 && (
                  <BlockStack gap="400">
                    <BlockStack gap="200">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text variant="headingMd" as="h3">Offer V4 — Hiya-Style Per-Kid Scaling Funnel</Text>
                        <Badge tone="success">Active (ID: 9656359256305)</Badge>
                      </InlineStack>
                      <Text as="p" tone="subdued">
                        <strong>First Rebill Interval:</strong> Exactly 28 days after Order #1 (automated by webhook). Subsequent rebills occur every 30 days.
                        <br />
                        <strong>Gift Quantity Multiplier:</strong> Physical gifts on recurring cycles (2 through 6) are dynamically multiplied by the customer's household kid count ($N$).
                      </Text>
                    </BlockStack>
                    {ladderV4 ? (
                      <DataTable
                        columnContentTypes={['text', 'text', 'text', 'text']}
                        headings={['Cycle', 'Gift Variants', 'Price', 'Quantity Math']}
                        rows={renderTableRows(ladderV4, true)}
                      />
                    ) : (
                      <Text tone="subdued">No V4 ladder data loaded.</Text>
                    )}
                  </BlockStack>
                )}

                {!loading && !error && selectedTab === 1 && (
                  <BlockStack gap="400">
                    <BlockStack gap="200">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text variant="headingMd" as="h3">Offer V3 — 60-Day Starter Kit Funnel</Text>
                        <Badge tone="info">Active (ID: 9656256463089)</Badge>
                      </InlineStack>
                      <Text as="p" tone="subdued">
                        <strong>First Rebill Interval:</strong> Automatically pushed out to 50 days after Order #1 to accommodate the 60-day 2-bag starter supply. Subsequent rebills occur every 28 days.
                      </Text>
                    </BlockStack>
                    {ladderV3 ? (
                      <DataTable
                        columnContentTypes={['text', 'text', 'text', 'text']}
                        headings={['Cycle', 'Gift Variants', 'Price', 'Count']}
                        rows={renderTableRows(ladderV3, false)}
                      />
                    ) : (
                      <Text tone="subdued">No V3 ladder data loaded.</Text>
                    )}
                  </BlockStack>
                )}

                {!loading && !error && selectedTab === 2 && (
                  <BlockStack gap="400">
                    <BlockStack gap="200">
                      <InlineStack align="space-between" blockAlign="center">
                        <Text variant="headingMd" as="h3">Original Legacy Funnel</Text>
                        <Badge>Legacy (ID: 9636915151089)</Badge>
                      </InlineStack>
                      <Text as="p" tone="subdued">
                        <strong>Rebill Interval:</strong> Standard 28-day cadence. Existing subscriber protection enabled.
                      </Text>
                    </BlockStack>
                    {ladderOld ? (
                      <DataTable
                        columnContentTypes={['text', 'text', 'text', 'text']}
                        headings={['Cycle', 'Gift Variants', 'Price', 'Count']}
                        rows={renderTableRows(ladderOld, false)}
                      />
                    ) : (
                      <Text tone="subdued">No legacy ladder data loaded.</Text>
                    )}
                  </BlockStack>
                )}
              </Box>
            </Tabs>
          </Card>
        </Layout.Section>

        <Layout.Section>
          <Card>
            <BlockStack gap="300">
              <Text variant="headingMd" as="h2">How The Automated Routing Works</Text>
              <Text as="p">
                1. When any recurring subscription charge is paid in Recharge, an event payload is sent to our single webhook endpoint.
              </Text>
              <Text as="p">
                2. Our backend inspects the line items and matches the Product ID against <strong>Offer V4 (9656359256305)</strong>, <strong>Offer V3 (9656256463089)</strong>, or <strong>Legacy (9636915151089)</strong>.
              </Text>
              <Text as="p">
                3. Based on the matched funnel, the server executes the corresponding rebill schedule adjustments (28 days vs 50 days) and gift injection logic (scaled by Kid Count $N$ for V4).
              </Text>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
