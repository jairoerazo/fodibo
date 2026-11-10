import 'package:flutter_test/flutter_test.dart';
import 'package:fodibo_transfer/ui/app.dart';

void main() {
  test('deviceNameOf: modelo del dispositivo o «Android» si viene vacío', () {
    expect(deviceNameOf('Pixel 8'), 'Pixel 8');
    expect(deviceNameOf('  Pixel 8 '), 'Pixel 8');
    expect(deviceNameOf(''), 'Android');
    expect(deviceNameOf('   '), 'Android');
    expect(deviceNameOf('x' * 150), hasLength(100)); // device_name: 1..100 caracteres
  });
}
