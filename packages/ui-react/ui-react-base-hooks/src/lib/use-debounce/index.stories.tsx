// useDebounce.stories.tsx
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { useDebounce } from '.';

const meta: Meta = {
  title: 'Hooks/useDebounce',
  tags: ['autodocs'],
};

export default meta;

function DebouncedInput() {
  const [inputValue, setInputValue] = useState('');
  const [debouncedValue, setDebouncedValue] = useDebounce('', 500);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <label className="block text-sm font-medium">
          Type something (500ms debounce):
        </label>
        <input
          type="text"
          className="border rounded p-2 w-full"
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value);
            setDebouncedValue(e.target.value);
          }}
        />
      </div>
      <div className="space-y-2">
        <div className="text-sm font-medium">Input Value:</div>
        <div className="p-2 bg-gray-100 rounded">{inputValue}</div>
      </div>
      <div className="space-y-2">
        <div className="text-sm font-medium">Debounced Value:</div>
        <div className="p-2 bg-gray-100 rounded">{debouncedValue}</div>
      </div>
    </div>
  );
}

export const Basic: StoryObj = {
  render: () => <DebouncedInput />,
};
