import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '小鱼食品保研| 保研面试训练系统',
  description: '保研面试随机抽题、录音作答与历史复盘系统',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
