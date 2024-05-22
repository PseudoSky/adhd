import stats from './stats';

describe('transforms', () => {
  it('should work', () => {

    expect(stats.getMin(1,5)).toEqual(1);
    expect(stats.getMax(1,5)).toEqual(5);
    expect(`${stats.randomRange(0,1)}`).toMatch(/0\.\d{15}/);
    expect(`${stats.randomRangeInt(1,10)}`).toMatch(/[1-9]/);
    // expect(stats.normalizeValue(5, 0, 4)).toEqual([0,1,2,3,4]);
    expect(stats.roundToIncrement(1.2, 1)).toEqual(1);
    expect(stats.roundToIncrement(1.26,.5)).toEqual(1.5);
    expect(stats.range([1, 2, 3, 4, 5])).toEqual({ max: 5, min: 1 });
    expect(stats.normalize([1, 2, 3, 4, 5], { max: 4, min: 0 })).toEqual([
      0, 1, 2, 3, 4,
    ]);
    expect(stats.normalizeBetween(1, 1, 10, 1, 10)).toEqual(1);
    expect(stats.makeListNormalizer([1,2,3,4,5],1,10)(2)).toEqual(3.25);
    expect(stats.histogram([1,2,3,4,5])).toEqual(new Map([[1,1],[2,1],[3,1],[4,1],[5,1]]));
    expect(stats.mostCommon([1,2,3,4,5])).toEqual(1);
    expect([...new stats.Counter([1,2,3,4,5]).entries()]).toEqual([[1,1],[2,1],[3,1],[4,1],[5,1]]);
    // Broken below
    expect(new stats.NormalizedHistogram([1,2,3,4,5],10,1,.5).bins(1,10)).toEqual([]);
    // [{"x": 1,"y": 1}, {"x": 2,"y": 1}, {"x": 3,"y": 1}, {"x": 4,"y": 1}, {"x": 5,"y": 1}]
  });
});



// import React, { useCallback, useMemo, useState } from "react";
// import {View} from 'react-native';
// import RangeSlider from "@ptomasroos/react-native-multi-slider";
// import RangeSliderLabel from './RangeSliderLabel'
// import Svg, { G, Line, Rect, Text } from 'react-native-svg'
// import {Stats, Collections} from '@adhd/utils'
// import PropTypes from 'prop-types'
// import {Sample} from './TestData.test.js'

// // TODO: Use this
// // https://github.com/JesperLekland/react-native-svg-charts#barchart

// const GRAPH_BAR_HEIGHT = 20;
// const colors = {
//   axis: "rgba(0,0,0,.4)",
//   text: "grey",
//   bars: {
//     active: "rgba(100,100,200,.5)",
//     inactive: "rgba(100,100,200,.2)",
//   },
// };


// // const SAMPLE = [
// //     { x: 1, y: 11 },
// //     { x: 2, y: 1 },
// //     { x: 3, y: 3 },
// //     { x: 4, y: 0 },
// //     { x: 5, y: 3 },
// //     { x: 6, y: 0 },
// //     { x: 7, y: 1 },
// //     { x: 8, y: 0 },
// //     { x: 9, y: 1 },
// //     { x: 10, y: 11 }
// //   ]
// function Histogram({
//   width,
//   height,
//   onChange,
//   onUpdate,
//   filterMin,
//   filterMax,
//   data=Sample,
//   bins = 10,
//   // binStart = 0,
//   // binSize = 10,
//   feature = "rank"
// }) {

//   const SVGWidth = width;
//   const GRAPH_AXIS_HEIGHT = 10;
//   const graphHeight = height-40;
//   const SVGHeight = graphHeight + 2 * GRAPH_AXIS_HEIGHT;
//   const AXIS_LABEL_WIDTH = 45;
//   const graphWidth = SVGWidth - AXIS_LABEL_WIDTH * 2;
//   const GRAPH_PADDING = 5;
//   const GRAPH_LABEL_FONT_SIZE = 8;
//   const GRAPH_HEIGHT = graphHeight;
//   const GRAPH_WIDTH = graphWidth;
//   // Stats.NormalizedHistogram
//   // const frequencies = useMemo(() => Stats.histogram(data, feature), [data, feature])
//   const { yData, startRange, binSize, binWidth } = useMemo(() => {
//     const yData = Collections.pluck(data, feature);
//     const startRange = Stats.range(yData);
//     const binSize = Math.ceil((startRange.max - startRange.min) / bins);
//     const binWidth = graphWidth / (bins+1);
//     return {
//       yData,
//       binWidth,
//       startRange,
//       binSize
//     };
//   }, [data, bins, feature]);
//   // console.log({ yData, startRange, bins });
//   // const [filterMax, setFilterMax] = useState(startRange.max + 2 );
//   // const [filterMin, setFilterMin] = useState(startRange.max - 2);


//   const hist = new Stats.NormalizedHistogram(
//     yData,
//     bins,
//     startRange.min,
//     binSize,
//     true
//   );

//   const frequencies = hist.bins();
//   console.log({ frequencies: hist.counter });
//   let activeMax=null;
//   let activeMin=null;
//   let totalCount = 0;
//   frequencies.forEach(e => {
//     e.active = e.x > filterMin && e.x < filterMax;
//     if (e.active){
//       if (!activeMax || e.y > activeMax) activeMax = e.y;
//       if (e.y>0 && (!activeMin || e.y < activeMin)) activeMin = e.y;
//       totalCount += e.y
//       e.color = colors.bars.active
//     } else {
//       e.color=colors.bars.inactive
//     }
//   });
//   const handleUpdate = useCallback(
//     df => {
//       if(df){
//         const [min, max] = df;
//         const count = frequencies.reduce((res, e) => {
//           if (e.x <= max && e.x >= min) res += e.y;
//           return res;
//         }, 0);
//         onUpdate && onUpdate([min, max, count]);
//       }
//     },
//     [frequencies, onUpdate]
//   );
//   const yDomain = Collections.pluck(frequencies, 'y');
//   console.log({yDomain})
//   if (!data || !data.length || activeMax <= Number.MIN_SAFE_INTEGER ||activeMin>=Number.MAX_SAFE_INTEGER ){
//     return <Text>Loading</Text>
//   } else{
//     console.log(Object.keys(data[0]))
//   }
//     // const y = Stats.makeListNormalizer(
//     //   yDomain,
//     //   GRAPH_PADDING,
//     //   graphHeight - GRAPH_PADDING
//     // );

//     const y = value =>
//       value < Number.MAX_SAFE_INTEGER && value > Number.MIN_SAFE_INTEGER ?
//       Stats.normalizeBetween(
//         value,
//         hist.range.min,
//         hist.range.max,
//         0,
//         graphHeight - GRAPH_LABEL_FONT_SIZE
//       ): 0;
//     // Stats.normalizeBetween(
//     //   value,
//     //   binStart,
//     //   bins * binSize,
//     //   0,
//     //   graphHeight,
//     // );
//   const x = value =>
//     Math.floor(Stats.normalizeBetween(value, startRange.min, startRange.max, 1, graphWidth));
//   console.log(Collections.pluck(frequencies,'y').map(y))
//   return (
//     <View
//       style={{
//         flex: 1,
//         justifyContent: "space-around",
//         alignItems: "center",
//         alignContent: "center",
//         flexDirection: "column"
//       }}
//     >
//       <Svg width={SVGWidth} height={SVGHeight}>
//         <G
//           opacity={!activeMin || activeMin === activeMax ? 0 : 1}
//           x={0}
//           width={AXIS_LABEL_WIDTH}
//           y={graphHeight}
//         >
//           {/* Top value label */}
//           <Text
//             x={0}
//             y={-y(activeMin) + 4}
//             fill="black"
//             fontSize={12}
//             textAnchor="start"
//             fillOpacity={0.4}
//           >
//             {`Min ${activeMin}`}
//           </Text>
//           <Line
//             x={AXIS_LABEL_WIDTH - 5}
//             y1={-y(activeMin)}
//             x2={graphWidth}
//             y2={-y(activeMin)}
//             stroke={colors.axis}
//             strokeDasharray={[3, 3]}
//             strokeWidth="0.5"
//           />
//           {/* <Text
//             x={0}
//             y={-y(activeMax) + GRAPH_LABEL_FONT_SIZE}
//             fill="black"
//             fontSize={12}
//             textAnchor="start"
//             fillOpacity={0.4}
//           >
//             {`Max: ${activeMax}`}
//           </Text> */}
//         </G>
//         <G x={AXIS_LABEL_WIDTH} y={graphHeight}>
//           {/* bars */}
//           {frequencies.map(
//             item =>
//               item.y > 0 && (
//                 <Rect
//                   key={"bar" + item.x}
//                   x={x(item.x)}
//                   y={-y(item.y)}
//                   rx={4}
//                   width={binWidth}
//                   height={y(item.y)}
//                   fill={item.color}
//                 />
//               )
//           )}
//           {/* top axis */}

//           {/* middle axis */}
//           {/* <Line
//             x1="0"
//             y1={y(middleValue) * -1}
//             x2={graphWidth}
//             y2={y(middleValue) * -1}
//             stroke={colors.axis}
//             strokeDasharray={[3, 3]}
//             strokeWidth="0.5"
//           /> */}

//           {/* bottom axis */}
//           {/* <Line
//             x1="0"
//             y1="-2"
//             x2={graphWidth}
//             y2="-2"
//             stroke={"black"}
//             strokeWidth="0.5"
//           /> */}
//         </G>
//         <G
//           opacity={!activeMin || activeMin === activeMax ? 0 : 1}
//           x={GRAPH_WIDTH + AXIS_LABEL_WIDTH}
//           y={GRAPH_HEIGHT}
//         >
//           {/* Top value label */}
//           <Text
//             x="5"
//             y={-y(activeMax) + GRAPH_LABEL_FONT_SIZE / 2}
//             fill="black"
//             fontSize={12}
//             textAnchor="start"
//             fillOpacity={0.4}
//           >
//             {`Max: ${activeMax}`}
//           </Text>
//           <Line
//             x1={-graphWidth}
//             y1={-y(activeMax)}
//             x2={0}
//             y2={-y(activeMax)}
//             stroke={colors.axis}
//             strokeDasharray={[3, 3]}
//             strokeWidth="0.5"
//           />
//         </G>
//         <G x={AXIS_LABEL_WIDTH} y={graphHeight + GRAPH_AXIS_HEIGHT}>
//           {/* labels */}
//           {frequencies.map(item => (
//             <Text
//               key={"label" + item.x}
//               fontSize={GRAPH_LABEL_FONT_SIZE}
//               opacity={item.active ? 1 : 0.2}
//               x={x(item.x) + binWidth / 2}
//               y={GRAPH_LABEL_FONT_SIZE}
//               textAnchor="middle"
//             >
//               {item.x}
//             </Text>
//           ))}
//         </G>
//       </Svg>
//       <RangeSlider
//         values={[startRange.min - 2, startRange.max + 2]}
//         min={startRange.min - 2}
//         max={startRange.max + 2}
//         step={binSize}
//         selectedStyle={{
//           backgroundColor: colors.bars.active
//         }}
//         unselectedStyle={{
//           backgroundColor: colors.bars.inactive
//         }}
//         touchDimensions={{
//           height: 60,
//           width: 60,
//           borderRadius: 30,
//           slipDisplacement: 40
//         }}
//         customLabel={RangeSliderLabel}
//         snapped={false}
//         allowOverlap={false}
//         sliderLength={graphWidth}
//         onValuesChange={handleUpdate}
//         onValuesChangeFinish={handleUpdate}
//       />
//     </View>
//   );
// }

// Histogram.propTypes = {
//   width: PropTypes.number.isRequired,
//   height: PropTypes.number.isRequired,
//   onChange: PropTypes.func,
//   onUpdate: PropTypes.func.isRequired,
//   filterMin: PropTypes.number.isRequired,
//   filterMax: PropTypes.number.isRequired,
//   data: PropTypes.any.isRequired,
//   bins: PropTypes.number.isRequired,
//   // binStart = 0,
//   // binSize = 10,
//   feature: PropTypes.string.isRequired,
// };
// export default Histogram;