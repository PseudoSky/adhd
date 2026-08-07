// src/hooks/useThrottleState/useThrottleState.stories.tsx
import { Meta, Story } from '@storybook/react';
import React from 'react';
import { useThrottleState, UseThrottleStateOptions } from '.';

export default {
  title: 'Hooks/useThrottleState',
  parameters: {
    docs: {
      description: {
        component: 'A hook that provides a throttled state value.',
      },
    },
  },
} as Meta;

interface DemoProps extends UseThrottleStateOptions {
  initialValue: string;
}

const ThrottleStateComponent: React.FC<DemoProps> = ({
  initialValue,
  ...options
}) => {
  const [throttledValue, setValue] = useThrottleState(initialValue, options);
  const [inputValue, setInputValue] = React.useState(initialValue);
  const [updates, setUpdates] = React.useState<string[]>([]);

  React.useEffect(() => {
    setUpdates((prev) => [
      `Updated: ${throttledValue} (${new Date().toLocaleTimeString()})`,
      ...prev.slice(0, 9),
    ]);
  }, [throttledValue]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newValue = e.target.value;
    setInputValue(newValue);
    setValue(newValue);
  };

  return (
    <div style={{ padding: '20px' }}>
      <div style={{ marginBottom: '20px' }}>
        <label>
          Input Value:
          <input
            type="text"
            value={inputValue}
            onChange={handleChange}
            style={{ marginLeft: '10px' }}
          />
        </label>
      </div>

      <div style={{ marginBottom: '20px' }}>
        <strong>Throttled Value: </strong>
        {throttledValue}
      </div>

      <div>
        <h4>Update History: </h4>
        <ul>
          {updates.map((update, index) => (
            <li key={index}> {update} </li>
          ))}
        </ul>
      </div>
    </div>
  );
};

const Template: Story<DemoProps> = (args) => (
  <ThrottleStateComponent {...args} />
);

export const Default = Template.bind({});
Default.args = {
  initialValue: '',
  delay: 1000,
};

export const LeadingOnly = Template.bind({});
LeadingOnly.args = {
  initialValue: '',
  delay: 1000,
  leading: true,
  trailing: false,
};

export const TrailingOnly = Template.bind({});
TrailingOnly.args = {
  initialValue: '',
  delay: 1000,
  leading: false,
  trailing: true,
};
