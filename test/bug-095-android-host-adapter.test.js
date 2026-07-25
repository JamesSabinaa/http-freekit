import assert from 'node:assert/strict';
import test from 'node:test';
import { AndroidAdbInterceptor } from '../src/interceptors/android-adb-interceptor.js';

test('Android fallback selects the host adapter on the device subnet', async () => {
  const interceptor = new AndroidAdbInterceptor();
  interceptor._getHostInterfaces = () => [
    { name: 'VPN', address: '10.8.0.2', netmask: '255.255.255.0', prefixLength: 24 },
    { name: 'Wi-Fi', address: '192.168.50.5', netmask: '255.255.255.0', prefixLength: 24 },
    { name: 'Docker', address: '172.17.0.1', netmask: '255.255.0.0', prefixLength: 16 }
  ];
  interceptor._getDeviceIpv4Addresses = async () => ['192.168.50.42'];

  assert.equal(await interceptor._getHostIp('physical-device'), '192.168.50.5');
});

test('Android fallback refuses to guess when no adapter reaches the device', async () => {
  const interceptor = new AndroidAdbInterceptor();
  interceptor._getHostInterfaces = () => [
    { name: 'VPN', address: '10.8.0.2', netmask: '255.255.255.0', prefixLength: 24 }
  ];
  interceptor._getDeviceIpv4Addresses = async () => ['192.168.50.42'];

  await assert.rejects(
    interceptor._getHostIp('physical-device'),
    /Could not find a host network adapter reachable/
  );
});

test('Android fallback accepts an explicitly selected local adapter', async () => {
  const interceptor = new AndroidAdbInterceptor();
  interceptor._getHostInterfaces = () => [
    { name: 'Ethernet', address: '192.0.2.10', netmask: '255.255.255.0', prefixLength: 24 }
  ];
  interceptor._getDeviceIpv4Addresses = () => assert.fail('explicit selection does not need device discovery');

  assert.equal(
    await interceptor._getHostIp('physical-device', '192.0.2.10'),
    '192.0.2.10'
  );
});
