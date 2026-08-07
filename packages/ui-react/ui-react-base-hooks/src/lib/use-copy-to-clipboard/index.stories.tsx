// src/hooks/useCopyToClipboard/useCopyToClipboard.stories.tsx
import { Meta, Story } from '@storybook/react';
import React, { useState } from 'react';
import { useCopyToClipboard, UseCopyToClipboardOptions } from '.';

export default {
  title: 'Hooks/useCopyToClipboard',
  parameters: {
    docs: {
      description: {
        component:
          'A hook for copying text to clipboard with success and error states.',
      },
    },
  },
} as Meta;

interface DemoProps extends UseCopyToClipboardOptions {
  initialText: string;
}

const CopyComponent: React.FC<DemoProps> = ({ initialText, ...options }) => {
  const [text, setText] = useState(initialText);
  const { copied, error, copyToClipboard } = useCopyToClipboard(options);

  return (
    <div style={{ padding: '20px' }}>
      <div style={{ marginBottom: '20px' }}>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          style={{ width: '100%', minHeight: '100px' }}
          placeholder="Enter text to copy..."
        />
      </div>

      <div style={{ marginBottom: '20px' }}>
        <button
          onClick={() => copyToClipboard(text)}
          style={{ marginRight: '10px' }}
        >
          Copy to Clipboard
        </button>

        <button onClick={() => setText(initialText)}>Reset Text</button>
      </div>

      {copied && (
        <div style={{ color: 'green', marginBottom: '10px' }}>
          ✓ Copied to clipboard!
        </div>
      )}

      {error && (
        <div style={{ color: 'red', marginBottom: '10px' }}>
          ✗ Error: {error.message}
        </div>
      )}
    </div>
  );
};

const Template: Story<DemoProps> = (args) => <CopyComponent {...args} />;

export const Default = Template.bind({});
Default.args = {
  initialText: 'Hello, World!',
  successDuration: 2000,
};

export const CustomDuration = Template.bind({});
CustomDuration.args = {
  initialText: 'This message will show success for 5 seconds',
  successDuration: 5000,
};

export const WithCallbacks = Template.bind({});
WithCallbacks.args = {
  initialText: 'With success and error callbacks',
  onSuccess: () => console.log('Copied successfully!'),
  onError: (error) => console.error('Copy failed:', error),
};
