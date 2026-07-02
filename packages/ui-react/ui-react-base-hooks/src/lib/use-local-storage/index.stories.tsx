// src/hooks/useLocalStorage/useLocalStorage.stories.tsx
import { Meta, Story } from '@storybook/react';
import React from 'react';
import { useLocalStorage, UseLocalStorageOptions } from '.';

export default {
  title: 'Hooks/useLocalStorage',
  parameters: {
    docs: {
      description: {
        component:
          'A hook for persisting state in localStorage with sync across tabs.',
      },
    },
  },
} as Meta;

interface DemoProps extends UseLocalStorageOptions<any> {
  storageKey: string;
  initialValue: any;
}

const LocalStorageComponent: React.FC<DemoProps> = ({
  storageKey,
  initialValue,
  ...options
}) => {
  const [value, setValue, removeValue] = useLocalStorage(
    storageKey,
    initialValue,
    options
  );

  return (
    <div style={{ padding: '20px' }}>
      <div style={{ marginBottom: '20px' }}>
        <h3>Local Storage Demo</h3>
        <p>Storage Key: {storageKey}</p>
        <p>Current Value: {JSON.stringify(value)}</p>
      </div>

      <div style={{ display: 'flex', gap: '10px', marginBottom: '20px' }}>
        <button
          onClick={() =>
            setValue((prev: any) => (typeof prev === 'number' ? prev + 1 : 1))
          }
        >
          Increment
        </button>

        <button onClick={() => setValue(initialValue)}>Reset</button>

        <button onClick={removeValue}>Remove</button>
      </div>

      <div>
        <textarea
          value={JSON.stringify(value, null, 2)}
          onChange={(e) => {
            try {
              setValue(JSON.parse(e.target.value));
            } catch (error) {
              console.error('Invalid JSON');
            }
          }}
          style={{ width: '100%', minHeight: '100px' }}
        />
      </div>
    </div>
  );
};

const Template: Story<DemoProps> = (args) => (
  <LocalStorageComponent {...args} />
);

export const NumberStorage = Template.bind({});
NumberStorage.args = {
  storageKey: 'demo-number',
  initialValue: 0,
};

export const ObjectStorage = Template.bind({});
ObjectStorage.args = {
  storageKey: 'demo-object',
  initialValue: { count: 0, lastUpdated: new Date().toISOString() },
};

export const CustomSerializer = Template.bind({});
CustomSerializer.args = {
  storageKey: 'demo-custom',
  initialValue: new Date(),
  serializer: (date: Date) => date.toISOString(),
  deserializer: (str: string) => new Date(str),
};
