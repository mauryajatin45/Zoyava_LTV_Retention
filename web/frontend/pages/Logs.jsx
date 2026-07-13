import { useEffect, useState, useCallback } from 'react';
import {
  Page, Layout, Card, IndexTable, Badge, Text, Spinner,
  Button, Modal, BlockStack, Banner
} from '@shopify/polaris';
import { useTranslation } from "react-i18next";

export default function Logs() {
  const { t } = useTranslation();
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const [activeModalLog, setActiveModalLog] = useState(null);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      // In App Bridge v4, standard fetch automatically injects the session token
      const response = await fetch('/api/logs?limit=100');
      if (!response.ok) {
        throw new Error(`HTTP Error ${response.status}`);
      }
      const data = await response.json();
      setLogs(data.logs || []);
    } catch (err) {
      console.error('[Logs] Failed to fetch webhook logs:', err);
      setError('Failed to load logs. Ensure the backend is running and you have an active session.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchLogs();
  }, [fetchLogs]);

  const handleModalClose = useCallback(() => setActiveModalLog(null), []);

  const getStatusBadgeTone = (status) => {
    switch (status) {
      case 'SUCCESS': return 'success';
      case 'FAILED': return 'critical';
      case 'SKIPPED': return 'warning';
      default: return 'info';
    }
  };

  const rowMarkup = logs.map(
    (log, index) => (
      <IndexTable.Row id={String(log.id)} key={log.id} position={index}>
        <IndexTable.Cell>
          <Text variant="bodyMd" fontWeight="bold" as="span">
            {new Date(log.created_at).toLocaleString()}
          </Text>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Badge>{log.webhook_type}</Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          {log.funnel_type ? <Badge tone="info">{log.funnel_type}</Badge> : '-'}
        </IndexTable.Cell>
        <IndexTable.Cell>{log.cycle_number || '-'}</IndexTable.Cell>
        <IndexTable.Cell>{log.address_id}</IndexTable.Cell>
        <IndexTable.Cell>
          <Badge tone={getStatusBadgeTone(log.status)}>{log.status}</Badge>
        </IndexTable.Cell>
        <IndexTable.Cell>
          <Button size="micro" onClick={() => setActiveModalLog(log)}>View Details</Button>
        </IndexTable.Cell>
      </IndexTable.Row>
    )
  );

  return (
    <Page
      title="Webhook Execution Logs"
      subtitle="Monitor all LTV Retention engine webhook events, status, and payload details."
      primaryAction={{ content: 'Refresh', onAction: fetchLogs, loading }}
    >
      <Layout>
        <Layout.Section>
          {error && <Banner tone="critical" onDismiss={() => setError(null)}>{error}</Banner>}
          
          <Card padding="0">
            {loading && logs.length === 0 ? (
              <div style={{ padding: '2rem', textAlign: 'center' }}>
                <Spinner size="large" />
              </div>
            ) : (
              <IndexTable
                itemCount={logs.length}
                headings={[
                  { title: 'Timestamp' },
                  { title: 'Event' },
                  { title: 'Funnel' },
                  { title: 'Cycle' },
                  { title: 'Address ID' },
                  { title: 'Status' },
                  { title: 'Details' },
                ]}
                selectable={false}
              >
                {rowMarkup}
              </IndexTable>
            )}
          </Card>
        </Layout.Section>
      </Layout>

      {activeModalLog && (
        <Modal
          open={!!activeModalLog}
          onClose={handleModalClose}
          title={`Log Details: ${activeModalLog.webhook_type} (Address ${activeModalLog.address_id})`}
          large
        >
          <Modal.Section>
            <BlockStack gap="400">
              {activeModalLog.error_message && (
                <Banner tone="critical" title="Error Details">
                  <p>{activeModalLog.error_message}</p>
                </Banner>
              )}

              <div>
                <Text variant="headingSm" as="h3">Status</Text>
                <Badge tone={getStatusBadgeTone(activeModalLog.status)}>{activeModalLog.status}</Badge>
              </div>

              <div>
                <Text variant="headingSm" as="h3">Charge ID</Text>
                <Text as="p">{activeModalLog.charge_id}</Text>
              </div>

              <div>
                <Text variant="headingSm" as="h3">Next Charge Date Scheduled</Text>
                <Text as="p">{activeModalLog.next_charge_date ? new Date(activeModalLog.next_charge_date).toLocaleDateString() : 'N/A'}</Text>
              </div>

              <div>
                <Text variant="headingSm" as="h3">Gifts Injected (Variant IDs)</Text>
                <Text as="p" variant="codeBlock">
                  {JSON.stringify(activeModalLog.gifts_injected || [], null, 2)}
                </Text>
              </div>

              <div>
                <Text variant="headingSm" as="h3">Request Payload (From Recharge)</Text>
                <div style={{ maxHeight: '400px', overflowY: 'auto', backgroundColor: '#f4f6f8', padding: '10px', borderRadius: '4px' }}>
                  <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}>
                    {JSON.stringify(activeModalLog.request_payload, null, 2)}
                  </pre>
                </div>
              </div>
            </BlockStack>
          </Modal.Section>
        </Modal>
      )}
    </Page>
  );
}
