// src/lib/use-async/index.stories.tsx
import { Meta, Story } from '@storybook/react';
import React from 'react';
import { useAsync } from '.';

export default {
  title: 'Hooks/useAsync',
  parameters: {
    docs: {
      description: {
        component:
          'A hook for handling async operations with loading, success, and error states.',
      },
    },
  },
} as Meta;

interface User {
  id: number;
  name: string;
  email: string;
}

interface ApiResponse {
  data: {
    users: User[];
  };
}

const res: ApiResponse = {
  data: {
    users: [
      {
        id: 1,
        name: 'John Doe',
        email: 'john.doe@example.com',
      },
      {
        id: 2,
        name: 'Jane Doe',
        email: 'jane.doe@example.com',
      },
    ],
  },
};

// Mock API call
const mockFetch = (shouldSucceed = true, delay = 1000): Promise<ApiResponse> =>
  new Promise((resolve, reject) => {
    setTimeout(() => {
      if (shouldSucceed) {
        resolve(res);
      } else {
        reject(new Error('Failed to fetch data'));
      }
    }, delay);
  });

interface DemoProps {
  shouldSucceed: boolean;
  delay: number;
  immediate: boolean;
}

const AsyncComponent: React.FC<DemoProps> = ({
  shouldSucceed,
  delay,
  immediate,
}) => {
  const cb = () => mockFetch(shouldSucceed, delay);
  const { execute, status, data, error, isLoading } = useAsync(cb, {
    immediate,
    onSuccess: (data) => console.log('Success:', data),
    onError: (error) => console.log('Error:', error),
  });

  return (
    <div style={{ padding: '20px' }}>
      <div style={{ marginBottom: '20px' }}>
        <button onClick={execute} disabled={isLoading}>
          {isLoading ? 'Loading...' : 'Fetch Data'}
        </button>
      </div>

      <div style={{ marginBottom: '10px' }}>
        Status: <strong>{status}</strong>
      </div>

      {data && (
        <div style={{ marginBottom: '10px' }}>
          <h4>Data:</h4>
          <pre>{JSON.stringify(data, null, 2)}</pre>
        </div>
      )}

      {error && (
        <div style={{ color: 'red' }}>
          <h4>Error:</h4>
          {error.message}
        </div>
      )}
    </div>
  );
};

const Template: Story<DemoProps> = (args) => <AsyncComponent {...args} />;

export const SuccessfulRequest = Template.bind({});
SuccessfulRequest.args = {
  shouldSucceed: true,
  delay: 1000,
  immediate: false,
};

export const FailedRequest = Template.bind({});
FailedRequest.args = {
  shouldSucceed: false,
  delay: 1000,
  immediate: false,
};

export const ImmediateRequest = Template.bind({});
ImmediateRequest.args = {
  shouldSucceed: true,
  delay: 1000,
  immediate: true,
};
