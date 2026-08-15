const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildSiteConfig,
  fillMissingGroupAutoSignTimes,
  filterSitesByGroup,
  getGroupAutoSignTime,
  getGroupCheckInAlarmName,
  groupSitesByGroup,
  normalizeGroupAutoSignTimes,
  normalizeSiteGroup,
  parseGroupCheckInAlarmName
} = require('../config.js');

function createSite(domain, group) {
  return {
    domain,
    siteId: domain.replace(/\./g, '_'),
    group
  };
}

test('默认分组兼容空值和默认标签', () => {
  assert.equal(normalizeSiteGroup(undefined), '');
  assert.equal(normalizeSiteGroup('  '), '');
  assert.equal(normalizeSiteGroup('默认'), '');
  assert.equal(normalizeSiteGroup(' 工作 '), '工作');
});

test('分组筛选只返回当前分组并保持站点顺序', () => {
  const sites = [
    createSite('default-a.example'),
    createSite('work-a.example', '工作'),
    createSite('default-b.example', '默认'),
    createSite('work-b.example', '工作'),
    createSite('other.example', '其他')
  ];

  assert.deepEqual(
    filterSitesByGroup(sites, '').map(site => site.domain),
    ['default-a.example', 'default-b.example']
  );
  assert.deepEqual(
    filterSitesByGroup(sites, '工作').map(site => site.domain),
    ['work-a.example', 'work-b.example']
  );
});

test('定时签到按默认分组优先并保持各组内部顺序', () => {
  const sites = [
    createSite('work-a.example', '工作'),
    createSite('default-a.example'),
    createSite('other-a.example', '其他'),
    createSite('work-b.example', '工作'),
    createSite('default-b.example')
  ];
  const groups = groupSitesByGroup(sites).filter(item => item.sites.length > 0);

  assert.deepEqual(groups.map(item => item.group), ['', '工作', '其他']);
  assert.deepEqual(
    groups.flatMap(item => item.sites).map(site => site.domain),
    [
      'default-a.example',
      'default-b.example',
      'work-a.example',
      'work-b.example',
      'other-a.example'
    ]
  );
});

test('后台站点配置保留规范化分组', () => {
  assert.equal(buildSiteConfig({ domain: 'default.example', group: '默认' }).group, '');
  assert.equal(buildSiteConfig({ domain: 'work.example', group: ' 工作 ' }).group, '工作');
});

test('分组签到时间规范化并按分组独立读取', () => {
  const times = normalizeGroupAutoSignTimes({ 默认: '08:00', 工作: ' 10:30 ' });

  assert.deepEqual(times, { '': '08:00', 工作: '10:30' });
  assert.equal(getGroupAutoSignTime(times, '', '09:00'), '08:00');
  assert.equal(getGroupAutoSignTime(times, '工作', '09:00'), '10:30');
  assert.equal(getGroupAutoSignTime(times, '其他', '09:00'), '09:00');
});

test('新分组首次调度时继承一次旧默认时间，之后可独立修改', () => {
  const sites = [
    createSite('default.example'),
    createSite('work.example', '工作')
  ];
  const filled = fillMissingGroupAutoSignTimes(sites, {}, '09:00');
  const changed = { ...filled, '': '08:00' };

  assert.deepEqual(filled, { '': '09:00', 工作: '09:00' });
  assert.equal(getGroupAutoSignTime(changed, '', '09:00'), '08:00');
  assert.equal(getGroupAutoSignTime(changed, '工作', '09:00'), '09:00');
});

test('分组闹钟名称可安全编码和还原默认分组', () => {
  for (const group of ['', '工作组/夜间', '中文 %']) {
    const parsed = parseGroupCheckInAlarmName(getGroupCheckInAlarmName(group));
    assert.deepEqual(parsed, { group: normalizeSiteGroup(group) });
  }
  assert.equal(parseGroupCheckInAlarmName('dailyCheckIn'), null);
});
