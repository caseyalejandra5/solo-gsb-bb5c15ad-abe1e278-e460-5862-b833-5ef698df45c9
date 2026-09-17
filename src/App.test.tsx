import { describe, expect, it } from 'vitest';
import { renderToString } from 'react-dom/server';
import { createElement } from 'react';
import App from './App';

describe('App 冒烟测试', () => {
  it('组件树可整体渲染', () => {
    const html = renderToString(createElement(App));
    expect(html).toContain('IPv4 子网规划台');
    expect(html).toContain('根网段');
    expect(html).toContain('地址空间树');
    expect(html).toContain('新建分配');
    expect(html).toContain('前缀策略校验');
  });
});
