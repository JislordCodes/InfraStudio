"""
Core functionality for the IFC Bonsai MCP addon.

This module implements a socket server that enables communication between
Blender and external MCP clients, executing commands in Blender's main thread
for safe interaction with the Blender API.
"""

import bpy
import json
import threading
import socket
import time
import traceback

server_instance = None

class BlenderMCPServer:
    """Socket server implementation for the IFC Bonsai MCP addon"""
    
    def __init__(self, host='localhost', port=9876):
        self.host = host
        self.port = port
        self.running = False
        self.socket = None
        self.server_thread = None
    
    def start(self):
        """Start the server"""
        if self.running:
            print("Server is already running")
            return
            
        self.running = True
        
        try:
            self.socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            self.socket.bind((self.host, self.port))
            self.socket.listen(1)
            
            self.server_thread = threading.Thread(target=self._server_loop)
            self.server_thread.daemon = True
            self.server_thread.start()
            
            print(f"BlenderMCP server started on {self.host}:{self.port}")
        except Exception as e:
            print(f"Failed to start server: {str(e)}")
            self.stop()
    
    def stop(self):
        """Stop the server"""
        self.running = False
        
        if self.socket:
            try:
                self.socket.close()
            except:
                pass
            self.socket = None
        
        if self.server_thread:
            try:
                if self.server_thread.is_alive():
                    self.server_thread.join(timeout=1.0)
            except:
                pass
            self.server_thread = None
        
        print("BlenderMCP server stopped")
            
    def _server_loop(self):
        """Main server loop in a separate thread"""
        print("Server loop starting")
        
        while self.running:
            try:
                self.socket.settimeout(0.5)
                try:
                    client, addr = self.socket.accept()
                    print(f"Client connected: {addr}")
                    client.settimeout(None)
                    
                    client_thread = threading.Thread(target=self._handle_client, args=(client,))
                    client_thread.daemon = True
                    client_thread.start()
                except socket.timeout:
                    continue
            except Exception as e:
                print(f"Error in server loop: {str(e)}")
                time.sleep(0.1)
                
        print("Server loop stopped")

    def _handle_client(self, client):
        """Handle connected client"""
        print("Client handler started")
        client.settimeout(None)
        buffer = b''
        
        try:
            while self.running:
                data = client.recv(4096)
                if not data:
                    break
                    
                buffer += data
                
                try:
                    command = json.loads(buffer.decode('utf-8'))
                    buffer = b''
                    
                    response = self.execute_command(command)
                    
                    client.sendall(json.dumps(response).encode('utf-8'))
                except json.JSONDecodeError:
                    continue
                except Exception as e:
                    print(f"Error handling client data: {str(e)}")
                    traceback.print_exc()
                    try:
                        error_response = {"status": "error", "message": str(e)}
                        client.sendall(json.dumps(error_response).encode('utf-8'))
                    except:
                        pass
        except Exception as e:
            print(f"Client handler error: {str(e)}")
        finally:
            try:
                client.close()
            except:
                pass
            print("Client disconnected")
    
    def execute_command(self, command):
        """Execute a command in the main Blender thread"""
        # Execute in main thread to avoid Blender crashes
        result_container = {'result': None, 'done': False}
        
        def command_executor():
            try:
                result_container['result'] = self._execute_command_internal(command)
            except Exception as e:
                print(f"Command execution error: {str(e)}")
                traceback.print_exc()
                result_container['result'] = {"status": "error", "message": str(e)}
            finally:
                result_container['done'] = True
                return None
        
        bpy.app.timers.register(command_executor)
        
        timeout = 30.0
        start_time = time.time()
        while not result_container['done']:
            time.sleep(0.01)
            if time.time() - start_time > timeout:
                return {"status": "error", "message": "Command execution timed out"}
        return result_container['result']
        
    def _execute_command_internal(self, command):
        """Internal command execution with proper context"""
        try:
            from . import commands as cmd_module
            
            command_type = command.get("type", "")
            params = command.get("params", {})
            
            if command_type == "ping":
                return {"status": "success", "result": "pong"}
                
            return cmd_module.execute_command(command_type, params)
            
        except Exception as e:
            traceback.print_exc()
            return {"status": "error", "message": str(e)}

def get_server_instance():
    """Get the current server instance"""
    return server_instance

def create_server_instance(port=9876):
    """Create a new server instance"""
    global server_instance
    if server_instance is None:
        server_instance = BlenderMCPServer(port=port)
    return server_instance

def register():
    """Register the module with Blender"""
    pass

def unregister():
    """Unregister the module from Blender"""
    global server_instance
    if server_instance:
        server_instance.stop()
        server_instance = None
