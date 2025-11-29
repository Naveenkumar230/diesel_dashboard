import serial
import time

port = serial.Serial('/dev/ttyUSB0', baudrate=9600, timeout=2)
print("Monitoring /dev/ttyUSB0 for 10 seconds...")
print("Waiting for any data...\n")

start = time.time()
while time.time() - start < 10:
    if port.in_waiting > 0:
        data = port.read(port.in_waiting)
        print(f"Received: {data.hex()} | ASCII: {data}")
    time.sleep(0.1)

print("\nDone")
port.close()