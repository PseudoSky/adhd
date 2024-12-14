import { useCallback, useEffect, useState } from 'react';

// Our hook
// export function useDebounce(value: any, delay: number | undefined) {
//   // State and setters for debounced value
//   let tmp = useRef(value)
//   const [targetValue, setTargetValue] = useState(value);
//   const [debouncedValue, setDebouncedValue] = useState();
//   const setTmpValue = useCallback((value: React.SetStateAction<undefined>) => {
//     console.log('Debounce value', {value})
//     setDebouncedValue(value)
//     // tmp.current = value;
//   }, [setDebouncedValue])
//   useEffect(
//     () => {
//       // Set debouncedValue to value (passed in) after the specified delay
//       console.log("tmp changed", debouncedValue);
//       const handler = setTimeout(() => {
//         if (debouncedValue !== targetValue) {
//           console.log("setDebouncedValue", debouncedValue);
//           setTargetValue(debouncedValue);
//         }
//       }, delay);

//       // Return a cleanup function that will be called every time ...
//       // ... useEffect is re-called. useEffect will only be re-called ...
//       // ... if value changes (see the inputs array below).
//       // This is how we prevent debouncedValue from changing if value is ...
//       // ... changed within the delay period. Timeout gets cleared and restarted.
//       // To put it in context, if the user is typing within our app's ...
//       // ... search box, we don't want the debouncedValue to update until ...
//       // ... they've stopped typing for more than 500ms.
//       return () => {
//         console.log("timeout cleared");
//         clearTimeout(handler);
//       };
//     },
//     // Only re-call effect if value changes
//     // You could also add the "delay" var to inputs array if you ...
//     // ... need to be able to change that dynamically.
//     [debouncedValue]
//   );

//   return [targetValue, setDebouncedValue];
// }

// export function useDebounce(value: any, delay: number | undefined) {
//   // State and setters for debounced value
//   const tmp = useRef(value);
//   const [targetValue, setTargetValue] = useState(value);
//   const setTmpValue = useCallback(
//     (value: any) => {
//       tmp.current = value;
//     },
//     [tmp]
//   ); // NOTE: modified add [tmp]
//   useEffect(
//     () => {
//       // Set debouncedValue to value (passed in) after the specified delay
//       console.log('tmp changed', tmp);
//       const handler = setTimeout(() => {
//         if (tmp.current !== targetValue) {
//           console.log('setDebouncedValue', tmp.current);
//           setTargetValue(tmp.current);
//           // setDebouncedValue(tmp.current);
//         }
//       }, delay);

//       // Return a cleanup function that will be called every time ...
//       // ... useEffect is re-called. useEffect will only be re-called ...
//       // ... if value changes (see the inputs array below).
//       // This is how we prevent debouncedValue from changing if value is ...
//       // ... changed within the delay period. Timeout gets cleared and restarted.
//       // To put it in context, if the user is typing within our app's ...
//       // ... search box, we don't want the debouncedValue to update until ...
//       // ... they've stopped typing for more than 500ms.
//       return () => {
//         console.log('timeout cleared');
//         clearTimeout(handler);
//       };
//     },
//     // Only re-call effect if value changes
//     // You could also add the "delay" var to inputs array if you ...
//     // ... need to be able to change that dynamically.
//     // eslint-disable-next-line react-hooks/exhaustive-deps
//     [tmp]
//   );

//   return [targetValue, setTmpValue];
// }


export function useDebounce<T>(initialValue: T, delay?: number): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(initialValue);
  const [debouncedValue, setDebouncedValue] = useState<T>(initialValue);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delay || 0);

    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);

  const setValueWithDebounce = useCallback((newValue: T) => {
    setValue(newValue);
  }, []);

  return [debouncedValue, setValueWithDebounce];
}


export default useDebounce;
