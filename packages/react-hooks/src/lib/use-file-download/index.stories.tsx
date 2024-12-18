import { expect } from '@storybook/jest';
import { Meta, Story } from '@storybook/react';
import { userEvent, within } from '@storybook/testing-library';
import React from 'react';
import { FileType, useFileDownload, UseFileDownloadProps } from './';

export default {
  title: 'Hooks/useFileDownload',
  parameters: {
    docs: {
      description: {
        component:
          'A hook for downloading data in various file formats with advanced features like compression, encryption, and validation.',
      },
    },
  },
} as Meta;

// Sample data sets
const sampleData = [
  {
    id: 1,
    name: 'John Doe',
    email: 'john@example.com',
    metadata: { lastLogin: '2023-01-01' },
  },
  {
    id: 2,
    name: 'Jane Smith',
    email: 'jane@example.com',
    metadata: { lastLogin: '2023-01-02' },
  },
];

const largeDataset = Array.from({ length: 10000 }, (_, i) => ({
  id: i + 1,
  name: `User ${i + 1}`,
  email: `user${i + 1}@example.com`,
  metadata: { lastLogin: new Date().toISOString() },
}));

interface DemoProps extends Omit<UseFileDownloadProps, 'data'> {
  dataSet: 'small' | 'large';
  enableCompression?: boolean;
  enableEncryption?: boolean;
  enableValidation?: boolean;
}

const DemoComponent: React.FC<DemoProps> = ({
  dataSet,
  fileName,
  enableCompression,
  enableEncryption,
  enableValidation,
  options = {},
}) => {
  const data = dataSet === 'small' ? sampleData : largeDataset;

  const { downloadFile, status, progress, error } = useFileDownload({
    data,
    fileName,
    options: {
      ...options,
      compression: enableCompression,
      encryption: enableEncryption
        ? {
            enabled: true,
            password: 'demo-password',
          }
        : undefined,
      validation: enableValidation
        ? {
            maxSize: 50 * 1024 * 1024,
            schema: {
              id: 'number',
              name: 'string',
              email: 'string',
            },
          }
        : undefined,
      onProgress: (progress) => {
        console.log(`Download progress: ${progress}%`);
      },
      onError: (error) => {
        console.error('Download error:', error);
      },
      onSuccess: (result) => {
        console.log('Download complete:', result);
      },
    },
  });

  const handleDownload = async (fileType: FileType) => {
    await downloadFile(fileType);
  };

  return (
    <div style={{ padding: '20px' }}>
      <h3>File Download Demo</h3>
      <div style={{ marginBottom: '20px' }}>
        <h4>Configuration:</h4>
        <ul>
          <li>
            Dataset: {dataSet} ({data.length} records)
          </li>
          <li>Compression: {enableCompression ? 'enabled' : 'disabled'}</li>
          <li>Encryption: {enableEncryption ? 'enabled' : 'disabled'}</li>
          <li>Validation: {enableValidation ? 'enabled' : 'disabled'}</li>
        </ul>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
        <button
          onClick={() => handleDownload('json')}
          disabled={status !== 'idle'}
          data-testid="json-button"
        >
          Download JSON
        </button>
        <button
          onClick={() => handleDownload('csv')}
          disabled={status !== 'idle'}
          data-testid="csv-button"
        >
          Download CSV
        </button>
        <button
          onClick={() => handleDownload('excel')}
          disabled={status !== 'idle'}
          data-testid="excel-button"
        >
          Download Excel
        </button>
        {/* <button
          onClick={() => {
            const base64 = generateBase64();
            console.log('Base64:', base64);
          }}
          disabled={status !== 'idle'}
          data-testid="base64-button"
        >
          Generate Base64
        </button> */}
      </div>

      {status !== 'idle' && (
        <div
          style={{
            marginTop: '20px',
            padding: '10px',
            borderRadius: '4px',
            backgroundColor: status === 'error' ? '#fee' : '#eef',
          }}
          data-testid="status-display"
        >
          <div>Status: {status}</div>
          {status !== 'error' && <div>Progress: {progress}%</div>}
          {error && <div style={{ color: 'red' }}>Error: {error.message}</div>}
        </div>
      )}

      <div style={{ marginTop: '20px' }}>
        <h4>Sample Data Preview:</h4>
        <pre style={{ maxHeight: '200px', overflow: 'auto' }}>
          {JSON.stringify(data.slice(0, 5), null, 2)}
          {data.length > 5 && '\n...'}
        </pre>
      </div>
    </div>
  );
};

const Template: Story<DemoProps> = (args) => <DemoComponent {...args} />;

export const BasicUsage = Template.bind({});
BasicUsage.args = {
  dataSet: 'small',
  fileName: 'basic-export',
  enableCompression: false,
  enableEncryption: false,
  enableValidation: false,
};

export const WithCompression = Template.bind({});
WithCompression.args = {
  dataSet: 'large',
  fileName: 'compressed-export',
  enableCompression: true,
  enableEncryption: false,
  enableValidation: false,
};

export const WithEncryption = Template.bind({});
WithEncryption.args = {
  dataSet: 'small',
  fileName: 'encrypted-export',
  enableCompression: false,
  enableEncryption: true,
  enableValidation: false,
};

export const WithValidation = Template.bind({});
WithValidation.args = {
  dataSet: 'small',
  fileName: 'validated-export',
  enableCompression: false,
  enableEncryption: false,
  enableValidation: true,
};

export const FullFeatures = Template.bind({});
FullFeatures.args = {
  dataSet: 'large',
  fileName: 'full-featured-export',
  enableCompression: true,
  enableEncryption: true,
  enableValidation: true,
};

// Interaction test
export const InteractionTest = Template.bind({});
InteractionTest.args = BasicUsage.args;
InteractionTest.play = async ({ canvasElement }) => {
  const canvas = within(canvasElement);

  // Click JSON download button
  await userEvent.click(canvas.getByTestId('json-button'));

  // Wait for status to appear
  const statusDisplay = await canvas.findByTestId('status-display');
  expect(statusDisplay).toBeInTheDocument();

  // Verify progress updates
  await expect(statusDisplay).toHaveTextContent(/progress/i);
};
