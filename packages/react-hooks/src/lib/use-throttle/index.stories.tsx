// src/hooks/useThrottle/useThrottle.stories.tsx
import { Meta, Story } from '@storybook/react';
import React, { useState } from 'react';
import { useThrottle, UseThrottleOptions } from './';

export default {
  title: 'Hooks/useThrottle',
  parameters: {
    docs: {
      description: {
        component: 'A hook that provides a throttled callback function.',
      },
    },
  },
} as Meta;

interface DemoProps extends UseThrottleOptions {
  initialCount?: number;
}

const ThrottleComponent: React.FC<DemoProps> = ({
  initialCount = 0,
  ...options
}) => {
  const [count, setCount] = useState(initialCount);
  const [lastUpdate, setLastUpdate] = useState<string>('');
  const [calls, setCalls] = useState<string[]>([]);

  const throttledIncrement = useThrottle(() => {
    setCount((c) => c + 1);
    setLastUpdate(new Date().toLocaleTimeString());
    setCalls((prev) => [
      `Called at: ${new Date().toLocaleTimeString()}`,
      ...prev.slice(0, 9),
    ]);
  }, options);

  return (
    <div style={{ padding: '20px' }}>
      <div style={{ marginBottom: '20px' }}>
        <h3>Count: {count} </h3>
        <p> Last Update: {lastUpdate || 'Never'} </p>
      </div>

      <div style={{ marginBottom: '20px' }}>
        <button onClick={throttledIncrement}>Increment(Throttled)</button>
      </div>

      <div>
        <h4>Call History: </h4>
        <ul>
          {calls.map((call, index) => (
            <li key={index}> {call} </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

const Template: Story<DemoProps> = (args) => <ThrottleComponent {...args} />;

export const Default = Template.bind({});
Default.args = {
  delay: 1000,
};

export const LeadingOnly = Template.bind({});
LeadingOnly.args = {
  delay: 1000,
  leading: true,
  trailing: false,
};

export const TrailingOnly = Template.bind({});
TrailingOnly.args = {
  delay: 1000,
  leading: false,
  trailing: true,
};
